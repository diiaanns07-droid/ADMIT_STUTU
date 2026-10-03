/* ASHEN OATH — презентация финала, слайды 3, 4, 5, 6 и 12.
 * Обычный скрипт без модулей и сетевых запросов: работает и из file://.
 * Слайды регистрируются в общей очереди DECK_QUEUE, её разбирает deck.js. */
(function () {
  'use strict';
  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  // Рамка-орнамент поверх кадра (класс .frame из deck.css)
  var RING = '<i class="frame p2-ring" aria-hidden="true"></i>';

  /* ---------- 3. Тело — это контроллер ---------- */
  Q.push({
    n: 3, sec: 40,
    html: `<section class="slide" data-slide="3" data-title="Тело — это контроллер">
  <header class="p2-head">
    <p class="kicker">Управление</p>
    <h2 class="thesis">Тело — это контроллер</h2>
  </header>
  <div class="p2-body">
    <figure class="p2-shot p2-s3-shot">
      <div class="p2-crop"><img src="../docs/screenshots/spirit/10_present.jpg" alt="Режим показа: слева скелет и кисти игрока, справа бой с Регентом и список жестов" loading="lazy" decoding="async"></div>
      <span class="p2-hl p2-hl--l" data-step="1" aria-hidden="true"></span>
      <span class="p2-hl p2-hl--r" data-step="2" aria-hidden="true"></span>
      <span class="p2-hl p2-hl--b" data-step="3" aria-hidden="true"></span>
      ${RING}
      <figcaption class="src p2-fig-note">Что видит камера и игра · кадр снят с клавиатуры</figcaption>
    </figure>
    <ol class="p2-s3-steps">
      <li class="p2-tick p2-tick--l" data-step="1"><span class="p2-tick-k">Левая рука</span><span class="p2-tick-t">ход, рывок, щит</span></li>
      <li class="p2-tick p2-tick--r" data-step="2"><span class="p2-tick-k">Правая</span><span class="p2-tick-t">снаряды, выброс, руны</span></li>
      <li class="p2-tick p2-tick--b" data-step="3"><span class="p2-tick-k">Две руки</span><span class="p2-tick-t">сфера и печати</span></li>
    </ol>
    <p class="cap p2-s3-cap">Без установки, датчиков и мыши.</p>
  </div>
  <aside class="notes">Камера видит скелет и кисти. Левая рука — руль: ход, бег, рывок с неуязвимостью и щит толчком ладони. Правая колдует: снаряды жестом «OK», выброс кулаком, руны пальцем. Двумя руками собирают сферу и ставят печати. Цвет руки на экране — тот же, что в игре: синий — движение, оранжевый — магия.</aside>
</section>`
  });

  /* ---------- 4. Один жест — удар, как в кино ---------- */
  Q.push({
    n: 4, sec: 40,
    html: `<section class="slide" data-slide="4" data-title="Один жест — удар, как в кино">
  <header class="p2-head">
    <p class="kicker">Ультимейт «Небесный суд»</p>
    <h2 class="thesis">Один жест — удар, как в кино</h2>
  </header>
  <div class="p2-body">
    <figure class="p2-shot p2-s4-shot">
      <div class="p2-crop">
        <video data-src="media/p2/ult_cinema.mp4" poster="media/p2/ult_poster.jpg" muted loop playsinline preload="none" aria-label="«Небесный суд»: облёт камеры и меч из света"></video>
        <img class="print-poster" src="media/p2/ult_poster.jpg" alt="">
      </div>
      ${RING}
      <figcaption class="cap p2-fig-note">Запись с клавиатуры; с камерой — на живом показе.</figcaption>
    </figure>
    <ol class="p2-seq">
      <li data-step="1"><span class="p2-seq-t">Обе руки над головой</span><span class="p2-seq-v">0,8 с</span></li>
      <li data-step="2"><span class="p2-seq-t">Облёт камеры</span><span class="p2-seq-v">3,6 с</span></li>
      <li data-step="3"><span class="p2-seq-t">Меч из света</span></li>
      <li class="p2-seq-hit" data-step="4"><span class="num" data-ignite>−28&#8239;%</span><span class="unit">здоровья Регента</span></li>
    </ol>
  </div>
  <aside class="notes">Это «Небесный суд» — ультимейт. Игрок держит обе руки над головой меньше секунды, камера облетает арену, с неба падает меч из света и снимает 28 % здоровья босса. Такой момент хочется повторить, и для этого нужно встать.</aside>
</section>`
  });

  /* ---------- 5. Глубина RPG, а не мини-игра ---------- */
  Q.push({
    n: 5, sec: 40,
    html: `<section class="slide" data-slide="5" data-title="Глубина RPG, а не мини-игра">
  <header class="p2-head">
    <p class="kicker">Глубина</p>
    <h2 class="thesis">Глубина RPG, а не мини-игра</h2>
  </header>
  <div class="p2-body">
    <figure class="p2-shot p2-s5-shot">
      <div class="p2-crop">
        <img src="../dev/shots/hero_v7_lineup.jpg" alt="Пять героев игры в полный рост" loading="lazy" decoding="async">
        <ul class="p2-names"><li>Пепельный страж</li><li>Эльфийка</li><li>Тёмная чародейка</li><li>Лучница</li><li>Архимаг</li></ul>
      </div>
      ${RING}
    </figure>
    <div class="p2-s5-stats">
      <p class="p2-s5-big"><span class="num" data-ignite>24</span><span class="unit">жеста</span></p>
      <p class="p2-s5-line"><b>10</b> рун · <b>4</b> печати · <b>2</b> магии ладонями · <b>5</b> героев · <b>2</b> фазы босса</p>
    </div>
    <ul class="p2-modes">
      <li data-step="1"><b>Бой с Регентом</b></li>
      <li data-step="2"><b>Испытание · 60 с</b> — ранг S–D, Зал славы дня</li>
      <li data-step="3"><b>Тренажёр техники</b></li>
      <li data-step="4"><b>Клятва героя</b></li>
      <li data-step="5"><b>Онлайн-дуэль</b> — WebRTC или LAN, до 2 побед из 3</li>
    </ul>
  </div>
  <aside class="notes">24 жеста, у каждого своё действие. Пять героев, босс с двумя фазами, режимы на минуту и на вечер. Дуэль работает и через интернет, и по локальной сети — для школьного Wi-Fi.</aside>
</section>`
  });

  /* ---------- 6. Не «не распознано», а «что исправить» ---------- */
  Q.push({
    n: 6, sec: 45,
    html: `<section class="slide" data-slide="6" data-title="Не «не распознано», а «что исправить»">
  <header class="p2-head">
    <p class="kicker">Подсказки «ОШИБКА»</p>
    <h2 class="thesis">Не «не распознано», а «что исправить»</h2>
  </header>
  <div class="p2-body">
    <figure class="p2-shot p2-s6-bat">
      <div class="p2-crop"><img src="../docs/screenshots/spirit/09_battle_mistake.jpg" alt="Бой: правая рука подсвечена красным, подсказка «Сомкни кончики большого и указательного в кольцо»" loading="lazy" decoding="async"></div>
      ${RING}
      <figcaption class="src p2-fig-note">Жест в бою · снято с клавиатуры</figcaption>
    </figure>
    <figure class="p2-shot p2-s6-sq">
      <div class="p2-crop">
        <video data-src="../docs/screenshots/squat/squat_demo.mp4" poster="media/p2/squat_poster.jpg" muted loop playsinline preload="none" aria-label="Тренировка клятвы: счёт приседаний и подсказки по технике"></video>
        <img class="print-poster" src="media/p2/squat_poster.jpg" alt="">
      </div>
      ${RING}
      <figcaption class="src p2-fig-note">Техника приседаний · стенд с записанной позой</figcaption>
    </figure>
    <div class="p2-s6-hint">
      <p class="p2-s6-big"><span class="num" data-ignite>63</span><span class="unit">подсказки</span></p>
      <p class="cap">49 к жестам · 14 к технике приседаний и отжиманий</p>
    </div>
    <ul class="p2-s6-steps">
      <li class="p2-tick" data-step="1"><span class="p2-tick-t">Голос тренера</span></li>
      <li class="p2-tick" data-step="2"><span class="p2-tick-t">1 повтор = 1 очко клятвы · 7 улучшений героя</span></li>
    </ul>
    <a class="p2-live" href="../index.html?demo&amp;present&amp;fury=100" target="_blank" rel="noopener" onclick="event.stopPropagation()">
      <svg viewBox="0 0 22 22" aria-hidden="true"><path d="M6 3.5 18 11 6 18.5z" fill="currentColor"/></svg>Живой показ</a>
  </div>
  <aside class="notes">Когда жест не получился, игра не пишет «не распознано». Она говорит, что исправить, — 63 конкретные подсказки, голосом и пиктограммой. Приседания и отжимания засчитываются только при правильной технике и усиливают героя.</aside>
</section>`
  });

  /* ---------- 12. Кому это нужно и что дальше ---------- */
  Q.push({
    n: 12, sec: 40,
    html: `<section class="slide" data-slide="12" data-title="Кому это нужно и что дальше">
  <header class="p2-head">
    <p class="kicker">Применение</p>
    <h2 class="thesis">Кому это нужно и что дальше</h2>
  </header>
  <div class="p2-body">
    <ul class="p2-who">
      <li data-step="1"><h3>Школа</h3><p>без установки, офлайн, режим LAN</p></li>
      <li data-step="2"><h3>Дом</h3><p>контроль техники приседаний и отжиманий</p></li>
      <li data-step="3"><h3>Доступность</h3><p>можно сидя; «Новичок» — 5 жестов и автоход; без мыши</p></li>
    </ul>
    <figure class="p2-shot p2-s12-shot">
      <div class="p2-crop"><img src="../docs/screenshots/challenge/9_poster_s.jpg" alt="Постер победы «Испытания · 60 с»: ранг S, 12 380 очков" loading="lazy" decoding="async"></div>
      ${RING}
    </figure>
    <div class="p2-next" data-step="4">
      <p class="p2-next-row"><span class="p2-next-k">В работе</span><span class="chip chip--wip">Быстрый вход · PR №39</span><span class="chip chip--wip">Камера на слабых ноутбуках</span><span class="chip chip--wip">Сложности «Сложная» и «Кошмар»</span></p>
      <p class="p2-next-row"><span class="p2-next-k">План</span><span class="chip">Казахский язык</span><span class="chip">Режим учителя</span><span class="chip">Пилот в школе</span></p>
    </div>
    <p class="cap p2-s12-cap">Не медицинское изделие.</p>
  </div>
  <aside class="notes">Игра работает там, где есть ноутбук: в классе, дома, на стуле. Серые пункты — уже в работе в ветках, но не в main, поэтому мы не выдаём их за готовое. Дальше — казахский язык, режим учителя и пилот в школе.</aside>
</section>`
  });
})();
