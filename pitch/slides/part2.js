/* ASHEN OATH — презентация финала, слайды 3, 4, 5, 6 и 12.
 * Обычный скрипт без модулей и сетевых запросов: работает и из file://.
 * Слайды регистрируются в общей очереди DECK_QUEUE, её разбирает deck.js.
 * Метка раздела и тезис стоят прямо в слайде (их место задаёт deck.css), содержимое — в .p2-body (полоса 260–960). */
(function () {
  'use strict';
  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  // Орнаментальная рамка поверх кадра (класс .frame из deck.css): отдельным слоем, чтобы уголки не прятались под картинкой
  var RING = '<i class="frame p2-ring" aria-hidden="true"></i>';

  /* ---------- 3. Тело — это контроллер ---------- */
  // Кадр «Что видит камера» (spirit/10_present.jpg без меток «КЛАВИАТУРА» и «DEBUG»; что это отладка — сказано в подписи): кольца цвета руки
  // прочерчиваются по шагам вокруг левой кисти, правой и обеих сразу. Координаты — в пикселях кадра 468×348.
  Q.push({
    n: 3, sec: 40,
    html: `<section class="slide" data-slide="3" data-title="Тело — это контроллер">
  <p class="kicker">Кейс Motion · камера вместо джойстика</p>
  <h2 class="thesis">Тело — это контроллер</h2>
  <div class="p2-body">
    <figure class="p2-shot p2-s3-shot">
      <div class="p2-crop"><img src="media/p2/spirit.jpg" alt="Окно «Что видит камера» в отладке с клавиатуры: скелет и обе кисти" decoding="async"></div>
      <svg class="p2-marks" viewBox="0 0 468 348" aria-hidden="true" focusable="false">
        <circle class="p2-mk p2-mk--l" data-step="1" cx="160" cy="158" r="50" pathLength="1"/>
        <circle class="p2-mk p2-mk--r" data-step="2" cx="304" cy="146" r="48" pathLength="1"/>
        <ellipse class="p2-mk p2-mk--b" data-step="3" cx="232" cy="152" rx="140" ry="82" pathLength="1"/>
      </svg>
      ${RING}
      <figcaption class="src p2-fig-note">Окно «Что видит камера» · кадр из&nbsp;отладки с&nbsp;клавиатуры</figcaption>
    </figure>
    <ol class="p2-hands">
      <li class="p2-tick p2-tick--l" data-step="1"><span class="p2-tick-k">Левая рука</span><span class="p2-tick-t">ход, бег, рывок, щит</span></li>
      <li class="p2-tick p2-tick--r" data-step="2"><span class="p2-tick-k">Правая</span><span class="p2-tick-t">снаряды, выброс, руны</span></li>
      <li class="p2-tick p2-tick--b" data-step="3"><span class="p2-tick-k">Две руки</span><span class="p2-tick-t">сфера, печати, «Врата бури»</span></li>
    </ol>
    <p class="cap p2-s3-cap">Без установки, датчиков и&nbsp;мыши.</p>
  </div>
  <aside class="notes">Камера видит скелет и 21 точку каждой кисти. Левая рука — руль: ход, бег, рывок с неуязвимостью и щит — резкий толчок ладонью к камере. Правая колдует: снаряды жестом «OK», выброс — кулак резко раскрыть, руны указательным пальцем. Двумя руками собирают сферу, ставят печати и открывают «Врата бури». Цвет руки на экране — тот же, что в игре: синий — движение, оранжевый — магия. Мышь нужна один раз — разрешить камеру; дальше меню и паузу нажимают пальцем. Кадр на слайде — из отладки, живую камеру покажем на демо.</aside>
</section>`
  });

  /* ---------- 4. Один жест — удар, как в кино ---------- */
  Q.push({
    n: 4, sec: 40,
    html: `<section class="slide" data-slide="4" data-title="Один жест — удар, как в кино">
  <p class="kicker">Ультимейт «Небесный суд»</p>
  <h2 class="thesis">Один жест — удар, как в&nbsp;кино</h2>
  <div class="p2-body">
    <figure class="p2-shot p2-s4-shot">
      <div class="p2-crop">
        <video data-src="media/p2/ult_cinema.mp4" poster="media/p2/ult_poster.jpg" muted loop playsinline preload="none" aria-label="«Небесный суд»: облёт камеры и меч из света"></video>
        <img class="print-poster" src="media/p2/ult_poster.jpg" alt="">
      </div>
      ${RING}
      <figcaption class="cap p2-fig-note">Запись с клавиатуры; с&nbsp;камерой — на&nbsp;живом показе.</figcaption>
    </figure>
    <ol class="p2-seq">
      <li data-step="1"><span class="p2-seq-t">Обе руки над головой</span><span class="p2-seq-v">0,8&nbsp;с</span></li>
      <li data-step="2"><span class="p2-seq-t">Облёт камеры</span><span class="p2-seq-v">3,6&nbsp;с</span></li>
      <li data-step="3"><span class="p2-seq-t">Меч из&nbsp;света</span></li>
      <li class="p2-seq-hit" data-step="4">
        <span class="num" data-ignite>−28&nbsp;%</span>
        <span class="unit">здоровья Регента</span>
        <span class="p2-hp" aria-hidden="true"><i class="p2-hp-loss"></i><i class="p2-hp-fill"></i></span>
      </li>
    </ol>
  </div>
  <aside class="notes">Это «Небесный суд» — ультимейт. В бою копится шкала «Ярость клятвы»; когда она полна, игрок держит обе руки над головой меньше секунды — камера облетает героя, с неба падает меч из света и снимает 28 % здоровья Регента. Такой момент хочется повторить, и для этого нужно встать.</aside>
</section>`
  });

  /* ---------- 5. Глубина RPG, а не мини-игра ---------- */
  Q.push({
    n: 5, sec: 40,
    html: `<section class="slide" data-slide="5" data-title="Глубина RPG, а не мини-игра">
  <p class="kicker">Что внутри</p>
  <h2 class="thesis">Глубина RPG, а&nbsp;не мини-игра</h2>
  <div class="p2-body">
    <figure class="p2-shot p2-s5-shot">
      <div class="p2-crop">
        <img src="media/p2/heroes.jpg" alt="Пять героев игры: Пепельный страж, Эльфийка, Тёмная чародейка, Лучница, Архимаг" decoding="async">
        <ul class="p2-names"><li>Пепельный страж</li><li>Эльфийка</li><li>Тёмная чародейка</li><li>Лучница</li><li>Архимаг</li></ul>
      </div>
      ${RING}
    </figure>
    <ul class="p2-stats">
      <li><span class="num" data-ignite>24</span><span class="unit">жеста</span></li>
      <li><span class="num">5</span><span class="unit">героев</span></li>
      <li><span class="num">5</span><span class="unit">режимов</span></li>
    </ul>
  </div>
  <aside class="notes">24 жеста, у каждого своё действие: 10 рун, 4 печати и две техники «ладони вместе» — «Врата бури» и «Столп небес». Пять героев и босс с двумя фазами. Пять режимов — на минуту и на вечер: бой с Регентом; «Испытание · 60 с» с рангом S–D и Залом славы дня; тренажёр техники; «Клятва героя» — отжимания и приседания; онлайн-дуэль до 2 побед из 3 — через интернет (WebRTC) или по локальной сети, если школьный Wi-Fi режет соединение.</aside>
</section>`
  });

  /* ---------- 6. Не «не распознано», а «что исправить» ---------- */
  Q.push({
    n: 6, sec: 45,
    html: `<section class="slide" data-slide="6" data-title="Не «не распознано», а «что исправить»">
  <p class="kicker">Твист кейса · ОШИБКА</p>
  <h2 class="thesis">Не «не распознано», а&nbsp;«что исправить»</h2>
  <div class="p2-body">
    <figure class="p2-shot p2-s6-bat">
      <div class="p2-crop"><img src="../docs/screenshots/spirit/09_battle_mistake.jpg" alt="Бой: правая рука подсвечена красным, подсказка «Сомкни кончики большого и указательного в кольцо»" decoding="async"></div>
      ${RING}
      <figcaption class="cap p2-fig-note">Бой; снято с&nbsp;клавиатуры.</figcaption>
    </figure>
    <figure class="p2-shot p2-s6-sq">
      <div class="p2-crop">
        <video data-src="../docs/screenshots/squat/squat_demo.mp4" poster="media/p2/squat_poster.jpg" muted loop playsinline preload="none" aria-label="Тренировка клятвы: счёт приседаний и подсказки по технике"></video>
        <img class="print-poster" src="media/p2/squat_poster.jpg" alt="">
      </div>
      ${RING}
      <figcaption class="cap p2-fig-note">Стенд; с&nbsp;камерой — на&nbsp;живом показе.</figcaption>
    </figure>
    <div class="p2-s6-hint">
      <span class="num" data-ignite>63</span>
      <p class="p2-s6-what"><span class="unit">подсказки</span><span class="cap">49 к&nbsp;жестам · 14 к&nbsp;технике приседаний и&nbsp;отжиманий</span></p>
    </div>
    <ul class="p2-s6-steps">
      <li class="p2-tick" data-step="1"><span class="p2-tick-t">Голос тренера</span></li>
      <li class="p2-tick" data-step="2"><span class="p2-tick-t">Присед — очко клятвы, чистый — два<span class="p2-sep"> · </span>7&nbsp;улучшений героя</span></li>
    </ul>
    <a class="p2-live" href="../index.html?demo&amp;present&amp;fury=100" target="_blank" rel="noopener" title="Бой с полной шкалой ярости; нужен сайт или serve_game.py">
      <svg viewBox="0 0 22 22" aria-hidden="true"><path d="M6 3.5 18 11 6 18.5z" fill="currentColor"/></svg>Живой показ</a>
  </div>
  <aside class="notes">Когда жест не получился, игра не пишет «не распознано». Она говорит, что исправить, — 63 конкретные подсказки, голосом и пиктограммой. Упражнения тоже под присмотром: отжимание засчитывается только с правильной техникой — одно очко клятвы; приседание в «Новичке» — очко, чистое — два, в «Мастере» засчитываются только чистые. Очки открывают 7 улучшений героя. Живой показ — с сайта или через serve_game.py (из файла игра не стартует); приседания вживую: «Клятва героя» → «Тренировка» → «Приседания».</aside>
</section>`
  });

  /* ---------- 12. Кому это нужно и что дальше ---------- */
  Q.push({
    n: 12, sec: 40,
    html: `<section class="slide" data-slide="12" data-title="Кому это нужно и что дальше">
  <p class="kicker">Применение</p>
  <h2 class="thesis">Кому это нужно и&nbsp;что дальше</h2>
  <div class="p2-body">
    <ul class="p2-who">
      <li data-step="1"><h3>Школа</h3><p>без установки, офлайн,&nbsp;LAN</p></li>
      <li data-step="2"><h3>Дом</h3><p>контроль техники приседаний и&nbsp;отжиманий</p></li>
      <li data-step="3"><h3>Доступность</h3><p>можно сидя; «Новичок»&nbsp;— 5&nbsp;базовых жестов и&nbsp;автоход; без&nbsp;мыши</p></li>
    </ul>
    <figure class="p2-shot p2-s12-shot">
      <div class="p2-crop"><img src="../docs/screenshots/challenge/9_poster_s.jpg" alt="Постер победы «Испытания · 60 с»: ранг S, 12 380 очков" decoding="async"></div>
      ${RING}
    </figure>
    <div class="p2-next" data-step="4">
      <p class="p2-next-row"><span class="src p2-next-k">В работе · не в&nbsp;main</span><span class="chip chip--wip">Быстрый вход · PR&nbsp;№39</span><span class="chip chip--wip">Камера на&nbsp;слабых ноутбуках</span><span class="chip chip--wip">Сложности «Сложная» и&nbsp;«Кошмар»</span></p>
      <p class="p2-next-row"><span class="src p2-next-k">План</span><span class="chip">Казахский язык</span><span class="chip">Режим учителя</span><span class="chip">Пилот в&nbsp;школе</span></p>
    </div>
    <p class="src p2-s12-cap">Не медицинское изделие.</p>
  </div>
  <aside class="notes">Игра работает там, где есть ноутбук: в классе — по ссылке без установки и офлайн после первого открытия, а дуэль по локальной сети — через START_GAME.cmd (нужен Python 3); дома — с контролем техники приседаний и отжиманий; сидя — режим «Новичок»: 5 базовых жестов и автоход, меню без мыши после разрешения камеры. Серые пункты — уже в работе в ветках, но не в main, поэтому мы не выдаём их за готовое. Дальше — казахский язык, режим учителя и пилот в школе.</aside>
</section>`
  });
})();
