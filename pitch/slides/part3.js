/* Слайды 7–11: что изменилось со 2 октября и как это работает.
 * Обычный скрипт без модулей: работает и из file://. Регистрация — в window.DECK_QUEUE (контракт К3).
 * Состояния шагов (заливка «Ярости», шторка, свет по схеме) описаны в part3.css через .is-on,
 * поэтому при входе назад и в печати слайд показан целиком без участия скрипта. */
(function () {
  'use strict';

  // Стрелка: в шрифтах нет «→», рисуем SVG того же цвета, что текст.
  var AR = '<svg class="p3-ar" viewBox="0 0 26 12" role="img" aria-label="→"><path d="M1 6h21M17 1.5 22.5 6 17 10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Руна-треугольник «▲» (в шрифтах тоже нет).
  var TRI = '<svg class="p3-tri" viewBox="0 0 12 12" role="img" aria-label="▲"><path d="M6 1.2 11 10.6H1z" fill="currentColor"/></svg>';

  // Вход и уход: пока слайд скрыт, его состояния меняются без анимации (класс .p3-instant),
  // чтобы при уходе шторка и заливка не «отматывались» на глазах, а при входе назад всё было сразу на месте.
  function enter(el) {
    el.classList.add('p3-instant');
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove('p3-instant'); }); });
  }
  function leave(el) { el.classList.add('p3-instant'); }

  // ---------------------------------------------------------------- 8. Шторка света: перетаскивание
  function wipeOf(el) { return el.querySelector('.p3-wipe'); }
  function wipeReset(el) {
    var w = wipeOf(el); if (!w) return;
    w.style.removeProperty('--p3-xm'); w.style.removeProperty('--p3-xb');
    w.classList.remove('is-drag', 'is-split');
  }
  function wipeBind(el) {
    var w = wipeOf(el); if (!w || w.p3Bound) return; w.p3Bound = true;
    function put(e) {
      var r = w.getBoundingClientRect(); if (!r.width) return;
      var x = Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100));
      var battle = !!el.querySelector('[data-step="2"].is-on');
      w.style.setProperty(battle ? '--p3-xb' : '--p3-xm', x.toFixed(2) + '%');
      w.classList.toggle('is-split', x > 0.5 && x < 99.5);
    }
    // Клики по шторке не листают слайды (движок листает кликом по краям экрана).
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
  }

  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  // ---------------------------------------------------------------- 7. Со 2 октября
  Q.push({
    n: 7, sec: 45,
    html: `<section class="slide p3-slide p3-s7" data-slide="7" data-title="Со 2 октября">
  <header class="p3-head">
    <p class="kicker">Со 2 октября — дня отбора в финал</p>
    <h2 class="thesis">Три волны за два дня</h2>
  </header>
  <div class="p3-body">
    <div class="p3-tl">
      <div class="p3-tl__rail" aria-hidden="true">
        <i class="p3-tl__fill p3-tl__fill--1"></i><i class="p3-tl__fill p3-tl__fill--2"></i><i class="p3-tl__fill p3-tl__fill--3"></i>
      </div>
      <ol class="p3-tl__nodes">
        <li class="p3-tl__node p3-tl__node--base">
          <span class="p3-tl__gem" aria-hidden="true"></span>
          <span class="p3-tl__date">30.09</span>
          <span class="p3-tl__name">версия отбора</span>
        </li>
        <li class="p3-tl__node p3-tl__node--1" data-step="1">
          <span class="p3-tl__gem" aria-hidden="true"></span>
          <span class="p3-tl__date">02.10</span>
          <h3 class="p3-tl__name">Доступность</h3>
          <ul class="p3-tl__list">
            <li>«Новичок» и автоход</li>
            <li>жесты на 8–15 Гц</li>
            <li>вход: 7 кликов ${AR} 2</li>
            <li>офлайн, свой звук</li>
          </ul>
        </li>
        <li class="p3-tl__node p3-tl__node--2" data-step="2">
          <span class="p3-tl__gem" aria-hidden="true"></span>
          <span class="p3-tl__date">02.10</span>
          <h3 class="p3-tl__name">Магия и режимы</h3>
          <ul class="p3-tl__list">
            <li>«Врата бури», «Столп небес»</li>
            <li>«Небесный суд», «Дух игрока»</li>
            <li>«Испытание · 60 с»</li>
            <li>голос тренера, курсор-кисть</li>
          </ul>
        </li>
        <li class="p3-tl__node p3-tl__node--3" data-step="3">
          <span class="p3-tl__gem" aria-hidden="true"></span>
          <span class="p3-tl__date">03.10</span>
          <h3 class="p3-tl__name">Картинка</h3>
          <ul class="p3-tl__list">
            <li>новый Регент</li>
            <li>интерфейс RPG, арена</li>
            <li>лица, волосы, наряды</li>
            <li>аура, витрина меню</li>
          </ul>
        </li>
      </ol>
    </div>
    <div class="p3-s7__nums">
      <div class="p3-s7__hero">
        <span class="num" data-ignite>36</span>
        <span class="unit">влитых PR<small>до отбора — 1</small></span>
      </div>
      <ul class="p3-s7__metrics">
        <li><b class="p3-val">+387</b><span class="unit">коммитов</span></li>
        <li><b class="p3-val">54&nbsp;470 ${AR} 85&nbsp;840</b><span class="unit">строк кода игры, +58&nbsp;%</span></li>
        <li><b class="p3-val">75 ${AR} 104</b><span class="unit">модуля</span></li>
        <li><b class="p3-val">32 ${AR} 62</b><span class="unit">набора тестов: вдвое больше, 0&nbsp;падений</span></li>
      </ul>
    </div>
  </div>
  <aside class="notes">Нас отобрали по версии от 30 сентября. Со 2 октября мы влили 36 пулл-реквестов тремя волнами. Первая — доступность: новичок, слабые ноутбуки, офлайн. Вторая — магия и режимы. Третья — картинка уровня RPG. Кода стало больше на 58 %, тестов — вдвое, и ни одного падения.</aside>
</section>`,
    enter: enter, leave: leave
  });

  // ---------------------------------------------------------------- 8. Было → стало
  Q.push({
    n: 8, sec: 50,
    html: `<section class="slide p3-slide p3-s8" data-slide="8" data-title="Было → стало">
  <header class="p3-head">
    <p class="kicker">Было ${AR} стало</p>
    <h2 class="thesis">Та же игра, другой уровень</h2>
  </header>
  <div class="p3-body">
    <figure class="p3-wipe" aria-label="Шторка «до и после»: её можно тянуть мышью">
      <div class="p3-wipe__pair p3-wipe__pair--menu">
        <img class="p3-wipe__img" src="../docs/screenshots/menu.jpg" alt="Меню в версии отбора: три кнопки">
        <span class="p3-wipe__tag p3-wipe__tag--before">версия отбора · 30.09</span>
        <div class="p3-wipe__after">
          <img class="p3-wipe__img" src="../docs/screenshots/w4-check/01_menu.jpg" alt="Меню 3 октября: шесть режимов">
          <span class="p3-wipe__tag p3-wipe__tag--after">03.10</span>
        </div>
        <i class="p3-wipe__edge" aria-hidden="true"></i>
      </div>
      <div class="p3-wipe__pair p3-wipe__pair--battle">
        <img class="p3-wipe__img" src="../docs/screenshots/battle.jpg" alt="Бой в версии отбора: отладочные надписи">
        <span class="p3-wipe__tag p3-wipe__tag--before">версия отбора · 30.09</span>
        <div class="p3-wipe__after">
          <img class="p3-wipe__img" src="../docs/screenshots/w4-check/03_battle.jpg" alt="Бой 3 октября: интерфейс RPG">
          <span class="p3-wipe__tag p3-wipe__tag--after">03.10</span>
        </div>
        <i class="p3-wipe__edge" aria-hidden="true"></i>
      </div>
    </figure>
    <ol class="p3-s8__caps">
      <li class="p3-s8__cap" data-step="1"><b>Меню:</b> 3 кнопки ${AR} 6 режимов</li>
      <li class="p3-s8__cap" data-step="2"><b>Бой:</b> отладка ${AR} интерфейс RPG, «Ярость клятвы», «Дух игрока»</li>
    </ol>
    <p class="cap p3-s8__note">Кадры боя сняты с клавиатуры.</p>
    <div class="p3-s8__strip">
      <p class="p3-s8__cap p3-s8__cap--entry"><b>Вход:</b> 7 кликов ${AR} 2</p>
      <img class="p3-s8__shot" src="../docs/screenshots/onboarding_before.jpg" alt="До: семь кликов до боя">
      ${AR}
      <img class="p3-s8__shot" src="../docs/screenshots/onboarding_after.jpg" alt="После: два клика до боя">
    </div>
  </div>
  <aside class="notes">Слева то, что видело жюри на отборе, справа — сегодняшний main. Тот же экран и тот же герой. Вместо трёх кнопок — шесть режимов, вместо отладочных надписей — полноценный интерфейс, вход в бой за два клика вместо семи.</aside>
</section>`,
    enter: function (el) { wipeReset(el); wipeBind(el); enter(el); },
    leave: function (el) { leave(el); wipeReset(el); },
    step: function (el) { wipeReset(el); }
  });

  // ---------------------------------------------------------------- 9. Красивее — и легче
  Q.push({
    n: 9, sec: 35,
    html: `<section class="slide p3-slide p3-s9" data-slide="9" data-title="Красивее и легче">
  <header class="p3-head">
    <p class="kicker">Картинка и скорость</p>
    <h2 class="thesis">Красивее — и при этом легче</h2>
  </header>
  <div class="p3-body">
    <figure class="p3-s9__boss">
      <img src="../docs/screenshots/boss/compare_angles.jpg" alt="Регент Нимба до и после: обсидиан с золотом">
      <span class="frame" aria-hidden="true"></span>
    </figure>
    <figure class="p3-s9__vid">
      <video data-src="../docs/video/spells_before_after.mp4" poster="media/p3/spells_ba.jpg" muted loop playsinline preload="none"></video>
      <img class="print-poster" src="media/p3/spells_ba.jpg" alt="">
    </figure>
    <div class="p3-s9__stat">
      <span class="num" data-ignite>−26&nbsp;%</span>
      <span class="unit">вызовов отрисовки в бою</span>
      <p class="cap p3-s9__levels"><span>low 267 ${AR} 197</span><span>medium 426 ${AR} 317</span><span>high 634 ${AR} 468</span></p>
    </div>
    <ul class="p3-s9__steps">
      <li data-step="1"><b>Ассеты</b> 35,7 ${AR} 10&nbsp;МБ</li>
      <li data-step="2"><b>Заклинания</b> читаются с 5&nbsp;м</li>
      <li data-step="3"><b>Бюджет кадра:</b> 0 превышений на всех уровнях качества</li>
    </ul>
    <p class="src p3-s9__src">docs/visual-budget.md</p>
  </div>
  <aside class="notes">Регент теперь из обсидиана с золотом, у арены огонь и мокрый пол, у героев новые лица и наряды. Это не стоило производительности: вызовов отрисовки в бою стало на четверть меньше, ассеты сжались в три с половиной раза.</aside>
</section>`,
    enter: enter, leave: leave
  });

  // ---------------------------------------------------------------- 10. Всё считается в браузере
  // Схема из прежней презентации (слайд «Как работает»), упрощена до пяти узлов и перекрашена токенами.
  // Узел: x — левый край, 256×290 на высоте 70; иконка — в квадрате 72 по центру сверху.
  function node(i, x, step, icon, title, subs) {
    var cx = x + 128, y = 70;
    var s = subs.map(function (t, j) { return '<text class="p3-d-s" x="' + cx + '" y="' + (y + 236 + j * 34) + '">' + t + '</text>'; }).join('');
    return '<g class="p3-d-node p3-d-node--' + i + '"' + (step ? ' data-step="' + step + '"' : '') + '>' +
      '<rect class="p3-d-box" x="' + x + '" y="' + y + '" width="256" height="290" rx="3"/>' +
      '<path class="p3-d-gem" d="M' + (x + 228) + ' ' + (y - 14) + 'l14 14-14 14-14-14z"/>' +
      '<g class="p3-d-ico" transform="translate(' + cx + ' ' + (y + 82) + ')">' + icon + '</g>' +
      '<text class="p3-d-t" x="' + cx + '" y="' + (y + 194) + '">' + title + '</text>' + s + '</g>';
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
    return '<g class="p3-d-link p3-d-link--' + (i + 1) + '"><path class="p3-d-a" d="M' + a + ' 215H' + b + '"/><path class="p3-d-run" pathLength="100" d="M' + a + ' 215H' + b + '"/></g>';
  });
  var SVG10 = '<svg class="p3-d" viewBox="0 0 1680 384" role="img" aria-label="Схема: камера, MediaPipe в Web Worker на GPU, 21 точка кисти и поза, жесты и машины состояний, бой на three.js — всё внутри браузера">' +
    '<defs><marker id="p3-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" class="p3-d-ah"/></marker></defs>' +
    '<rect class="p3-d-zone" x="326" y="22" width="1354" height="358" rx="4"/>' +
    '<rect class="p3-d-zone-bg" x="345" y="4" width="196" height="36"/><text class="p3-d-k" x="360" y="32">Браузер</text>' +
    node(1, X[0], 0, ICON.cam, 'Камера', ['обычная', 'веб-камера']) +
    '<g data-step="1">' + GAP[0] + node(2, X[1], 0, ICON.chip, 'MediaPipe', ['0.10.35', 'Web Worker · GPU']) + '</g>' +
    '<g data-step="2">' + GAP[1] + node(3, X[2], 0, ICON.hand, '21 точка', ['кисти', 'и поза тела']) + '</g>' +
    '<g data-step="3">' + GAP[2] + node(4, X[3], 0, ICON.fsm, 'Жесты', ['и машины', 'состояний']) + '</g>' +
    '<g data-step="4">' + GAP[3] + node(5, X[4], 0, ICON.tri, 'Бой', ['three.js 0.185']) + '</g>' +
    '</svg>';

  // «Поза через кадр» на 63f908a не работает (убрана в 7532fe0, поза считается на каждом кадре),
  // поэтому про слабое железо — только то, что есть в коде: core/perfTuner.js и смена модели позы в main.js.
  Q.push({
    n: 10, sec: 40,
    html: `<section class="slide p3-slide p3-s10" data-slide="10" data-title="Как это работает">
  <header class="p3-head">
    <p class="kicker">Как это работает</p>
    <h2 class="thesis">Всё считается в браузере</h2>
  </header>
  <div class="p3-body">
    <div class="p3-s10__diagram">${SVG10}</div>
    <ul class="p3-s10__facts">
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M14 34h21a8 8 0 0 0 1-15.9A11 11 0 0 0 15 16a9 9 0 0 0-1 18z"/><path d="M8 42 40 8"/></svg><span><b>0 кадров в сеть,</b> микрофон не используется</span></li>
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M6 16 24 7l18 9v18l-18 9-18-9z"/><path d="M6 16l18 9 18-9M24 25v18"/></svg><span><b>Офлайн:</b> всё в vendor/, service worker</span></li>
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M7 34a17 17 0 1 1 34 0"/><path d="M24 34 33 20"/><circle cx="24" cy="34" r="3"/></svg><span><b>Слабое железо:</b> автонастройка разрешения и качества, быстрая модель позы, если точная не успевает</span></li>
    </ul>
  </div>
  <aside class="notes">Видео не покидает ноутбук: распознавание идёт в браузере, в отдельном потоке на видеокарте. Все библиотеки лежат в репозитории, поэтому игра работает без интернета — на сцене и в школе. На слабом ноутбуке игра сама снижает нагрузку.</aside>
</section>`,
    enter: enter, leave: leave
  });

  // ---------------------------------------------------------------- 11. Сложно — и проверено
  Q.push({
    n: 11, sec: 35,
    html: `<section class="slide p3-slide p3-s11" data-slide="11" data-title="Сложно — и проверено">
  <header class="p3-head">
    <p class="kicker">Проверка</p>
    <h2 class="thesis">Сложно — и проверено</h2>
  </header>
  <div class="p3-body">
    <div class="p3-s11__tiles">
      <article class="corner p3-tile">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="-36 -40 72 80" aria-hidden="true"><g class="p3-hand">${HAND}</g></svg>
        <span class="num" data-ignite>96&nbsp;%</span>
        <p class="unit">форм кисти на реальных фото HaGRID <span class="p3-dim">(130 из 135)</span></p>
      </article>
      <article class="corner p3-tile" data-step="1">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="0 0 84 72" aria-hidden="true"><path class="p3-ruler" d="M2 58h80"/><path class="p3-ticks" d="M7 52V22M17 52V22M27 52V22M37 52V22M47 52V22M57 52V22M67 52V22M77 52V22"/></svg>
        <span class="num">8<span class="unit p3-hz">Гц</span></span>
        <p class="unit">жесты держатся при распознавании 8–15 раз в&nbsp;секунду; руна ${TRI} на 8&nbsp;Гц — 83&nbsp;%, ложных&nbsp;0</p>
      </article>
      <article class="corner p3-tile" data-step="2">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="-40 -40 80 80" aria-hidden="true"><circle r="30"/><circle r="22" class="p3-thin"/><path d="M-12 1 -3 10 14 -9"/></svg>
        <span class="num">1100+</span>
        <p class="unit">автопроверок, 0&nbsp;падений</p>
      </article>
    </div>
    <p class="src p3-s11__src">dev/handGestures.real.test.mjs · dev/lowfps.test.mjs · прогон автотестов 03.10</p>
  </div>
  <aside class="notes">Жесты проверены на реальных фотографиях рук: 96 %. Они работают даже при 8 кадрах распознавания в секунду, это старый школьный ноутбук. Более тысячи ста автопроверок проходят без падений.</aside>
</section>`,
    enter: enter, leave: leave
  });
})();
