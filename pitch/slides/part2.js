/* ASHEN OATH — презентация финала, слайды 3, 4, 5, 6 и 12.
 * Обычный скрипт без модулей и сетевых запросов: работает и из file://.
 * Слайды регистрируются в общей очереди DECK_QUEUE, её разбирает deck.js.
 * Метка раздела и тезис стоят прямо в слайде (их место задаёт deck.css), содержимое — в .p2-body (полоса 260–960).
 * Анимации — по шагам и при входе вперёд; вход назад, переход по hash, «уменьшенное движение» и печать — сразу конечный вид. */
(function () {
  'use strict';
  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  // Орнаментальная рамка поверх кадра (класс .frame из deck.css): отдельным слоем, чтобы уголки не прятались под картинкой
  var RING = '<i class="frame p2-ring" aria-hidden="true"></i>';

  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  /* ---------- 3. Тело — это контроллер ---------- */
  // Клип «Дух игрока» (docs/video/spirit.mp4, 0–8,6 с). Справа внизу кадра игра сама пишет, что делает каждая рука
  // («ЛЕВАЯ: …», «ПРАВАЯ: …»): от этих строк к подписям по шагам прочерчиваются золотые выноски, подпись — следом.
  // Координаты выносок — в системе .p2-body (1680×700): строки состояния рук — x 1022, y 496 и 516.
  Q.push({
    n: 3, sec: 40,
    html: `<section class="slide" data-slide="3" data-title="Тело — это контроллер">
  <p class="kicker">Кейс Motion · камера вместо джойстика</p>
  <h2 class="thesis">Тело — это контроллер</h2>
  <div class="p2-body">
    <figure class="p2-shot p2-s3-shot">
      <div class="p2-crop">
        <video data-src="media/p2/spirit_cut.mp4" poster="media/p2/spirit_poster.jpg" muted loop playsinline preload="none" aria-label="Бой: «Дух игрока» повторяет руки, справа внизу — что делает каждая рука"></video>
        <img class="print-poster" src="media/p2/spirit_poster.jpg" alt="">
      </div>
      ${RING}
      <figcaption class="cap p2-fig-note">Бой; снято с&nbsp;клавиатуры.</figcaption>
    </figure>
    <svg class="p2-leads" viewBox="0 0 1680 700" aria-hidden="true" focusable="false">
      <g class="p2-lead p2-lead--l" data-step="1"><path d="M1022 496C1074 496 1050 112 1104 112" pathLength="1"/><circle cx="1022" cy="496" r="5"/></g>
      <g class="p2-lead p2-lead--r" data-step="2"><path d="M1022 516C1078 516 1050 256 1104 256" pathLength="1"/><circle cx="1022" cy="516" r="5"/></g>
      <g class="p2-lead p2-lead--b" data-step="3"><path d="M1030 506C1082 506 1056 400 1104 400" pathLength="1"/></g>
    </svg>
    <ol class="p2-hands">
      <li class="p2-tick p2-tick--l" data-step="1"><span class="p2-tick-k">Левая рука</span><span class="p2-tick-t">ход, бег, рывок, щит</span></li>
      <li class="p2-tick p2-tick--r" data-step="2"><span class="p2-tick-k">Правая</span><span class="p2-tick-t">снаряды, выброс, руны</span></li>
      <li class="p2-tick p2-tick--b" data-step="3"><span class="p2-tick-k">Две руки</span><span class="p2-tick-t">сфера, печати, «Врата бури»</span></li>
    </ol>
    <p class="cap p2-s3-cap">Без установки, датчиков и&nbsp;мыши.</p>
  </div>
  <aside class="notes">Камера видит скелет и 21 точку каждой кисти. Справа внизу игра пишет, что сейчас делает каждая рука. Левая — руль: ход, бег, рывок с неуязвимостью и щит — резкий толчок ладонью к камере. Правая колдует: снаряды жестом «OK», выброс — кулак резко раскрыть, руны указательным пальцем. Двумя руками собирают сферу, ставят печати и открывают «Врата бури». Мышь нужна один раз — разрешить камеру; дальше меню и паузу нажимают пальцем. Ролик снят с клавиатуры, живую камеру покажем на демо.</aside>
</section>`
  });

  /* ---------- 4. Один жест — удар, как в кино ---------- */
  // После шага «Меч из света» слайд ждёт удара меча в клипе (2,27 с от начала media/p2/ult_cinema.mp4 — резкая смена
  // сцены по ffmpeg scene) и ровно тогда «получает удар» вместе с Регентом: DECK.hit из движка (или своя встряска
  // и вспышка, если движок его ещё не умеет), счётчик «−28 %» и мини-полоса здоровья.
  var HIT_T = 2.27;
  var s4 = { raf: 0, armed: false, timer: 0 };
  function s4Stop() { cancelAnimationFrame(s4.raf); clearTimeout(s4.timer); s4.armed = false; }
  function s4Show(el, on) { el.querySelector('.p2-seq-hit').classList.toggle('p2-hit-on', on); if (on) el.querySelector('.p2-hit-n').textContent = '−28 %'; }
  function s4Fire(el) {
    s4Stop();
    var n = el.querySelector('.p2-hit-n');
    s4Show(el, true);
    var D = window.DECK;
    if (D && typeof D.hit === 'function') {
      try { D.hit(28, { shake: true, flash: true }); } catch (e) { console.error('DECK.hit', e); }
    } else {
      el.classList.add('p2-hit-local');
      s4.timer = setTimeout(function () { el.classList.remove('p2-hit-local'); }, 420);
    }
    var t0 = performance.now();
    (function tick(now) {
      var k = Math.min(1, (now - t0) / 500), e = 1 - Math.pow(1 - k, 3);
      n.textContent = '−' + Math.round(28 * e) + ' %';
      if (k < 1) s4.raf = requestAnimationFrame(tick);
    })(t0);
  }
  function s4Arm(el) {
    s4Stop();
    var v = el.querySelector('video'), start = performance.now();
    s4.armed = true;
    (function watch(now) {
      if (!s4.armed) return;
      var playing = v && !v.paused && !v.error && v.readyState >= 2, t = v ? v.currentTime : 0;
      // удар в кадре; запасной путь — клип не играет (нет кодека, не загрузился) или ждём дольше одного круга
      if ((playing && t >= HIT_T && t < HIT_T + 0.5) || (!playing && now - start > 1200) || now - start > 4200) { s4Fire(el); return; }
      s4.raf = requestAnimationFrame(watch);
    })(start);
  }
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
        <i class="p2-flash" aria-hidden="true"></i>
      </div>
      ${RING}
      <figcaption class="cap p2-fig-note">Запись с клавиатуры; с&nbsp;камерой — на&nbsp;живом показе.</figcaption>
    </figure>
    <ol class="p2-seq">
      <li data-step="1"><span class="p2-seq-t">Обе руки над головой</span><span class="p2-seq-v">0,8&nbsp;с</span></li>
      <li data-step="2"><span class="p2-seq-t">Облёт камеры</span><span class="p2-seq-v">3,6&nbsp;с</span></li>
      <li data-step="3"><span class="p2-seq-t">Меч из&nbsp;света</span></li>
      <li class="p2-seq-hit">
        <span class="num p2-hit-n">−28&nbsp;%</span>
        <span class="unit">здоровья Регента</span>
        <span class="p2-hp" aria-hidden="true"><i class="p2-hp-loss"></i><i class="p2-hp-fill"></i></span>
      </li>
    </ol>
  </div>
  <aside class="notes">Это «Небесный суд» — ультимейт. В бою копится шкала «Ярость клятвы»; когда она полна, игрок держит обе руки над головой меньше секунды — камера облетает героя, с неба падает меч из света и снимает 28 % здоровья Регента. После «меча» дождитесь удара в ролике — слайд вздрогнет вместе с Регентом. Такой момент хочется повторить, и для этого нужно встать.</aside>
</section>`,
    enter: function (el, dir) { s4Stop(); s4Show(el, dir < 0); },
    step: function (el, k) {
      if (k < 3 || el.querySelector('.p2-seq-hit').classList.contains('p2-hit-on')) return;
      if (reduced()) s4Show(el, true); else s4Arm(el);
    },
    leave: function (el) { s4Stop(); el.classList.remove('p2-hit-local'); }
  });

  /* ---------- 5. Глубина RPG, а не мини-игра ---------- */
  // Герои выходят по одному из золотой вспышки, как призыв на витрине меню; карточки режимов — лесенкой следом.
  // Полоса героев — один кадр media/p2/heroes.jpg (1656×366): каждая ячейка показывает свою пятую часть (331 px).
  var HEROES = ['Пепельный страж', 'Эльфийка', 'Тёмная чародейка', 'Лучница', 'Архимаг'];
  var MODES = ['Бой с&nbsp;Регентом', 'Испытание · 60&nbsp;с', 'Тренажёр техники', 'Клятва героя', 'Онлайн-дуэль'];
  Q.push({
    n: 5, sec: 40,
    html: `<section class="slide" data-slide="5" data-title="Глубина RPG, а не мини-игра">
  <p class="kicker">Что внутри</p>
  <h2 class="thesis">Глубина RPG, а&nbsp;не мини-игра</h2>
  <div class="p2-body">
    <figure class="p2-shot p2-s5-shot" data-morph="heroes">
      <div class="p2-crop">
        <ul class="p2-heroes" role="img" aria-label="Пять героев игры на витрине меню: ${HEROES.join(', ')}">
          ${HEROES.map(function (h, i) { return '<li style="--i:' + i + '"><img src="media/p2/heroes.jpg" alt="" decoding="async"><span class="p2-hero-name">' + h + '</span></li>'; }).join('')}
        </ul>
      </div>
      ${RING}
    </figure>
    <ul class="p2-stats">
      <li><span class="num" data-ignite>24</span><span class="unit">жеста</span></li>
      <li><span class="num">5</span><span class="unit">героев</span></li>
      <li><span class="num">5</span><span class="unit">режимов</span></li>
    </ul>
    <ul class="p2-modes">
      ${MODES.map(function (m, i) { return '<li style="--i:' + i + '">' + m + '</li>'; }).join('')}
    </ul>
  </div>
  <aside class="notes">24 жеста, у каждого своё действие: 10 рун, 4 печати и две техники «ладони вместе» — «Врата бури» и «Столп небес». Пять героев и босс с двумя фазами. Пять режимов — на минуту и на вечер: бой с Регентом; «Испытание · 60 с» с рангом S–D и Залом славы дня; тренажёр техники; «Клятва героя» — отжимания и приседания; онлайн-дуэль до 2 побед из 3 — через интернет (WebRTC) или по локальной сети, если школьный Wi-Fi режет соединение.</aside>
</section>`
  });

  /* ---------- 6. Не «не распознано», а «что исправить» ---------- */
  // История на стенде приседаний (dev/squat_stand.html, камера низко, симуляция позы): шаг 1 — колени завалились
  // внутрь, вокруг них прочерчивается красный круг и печатается голосовая подсказка игры «Колени наружу!»
  // (core/voicePhrases.js, valgus); шаг 2 — тот же ракурс, чистый повтор: золотое свечение и «+2» («Новичок»).
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
        <img class="p2-sq-in" src="media/p2/squat_in.jpg" alt="Стенд приседаний: колени завалились внутрь" decoding="async">
        <img class="p2-sq-out" data-step="2" src="media/p2/squat_out.jpg" alt="Тот же ракурс: чистый повтор, колени по линии носков" decoding="async">
        <i class="p2-sq-glow" data-step="2" aria-hidden="true"></i>
        <svg class="p2-knees" viewBox="0 0 400 360" aria-hidden="true" focusable="false"><ellipse data-step="1" cx="194" cy="196" rx="48" ry="40" pathLength="1"/></svg>
      </div>
      ${RING}
      <figcaption class="cap p2-fig-note">Стенд; с&nbsp;камерой — на&nbsp;живом показе.</figcaption>
    </figure>
    <p class="p2-say" data-step="1"><span class="p2-say-t">Колени наружу!</span></p>
    <p class="p2-plus" data-step="2"><span class="num">+2</span></p>
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
  <aside class="notes">Когда жест не получился, игра не пишет «не распознано». Она говорит, что исправить, — 63 конкретные подсказки, голосом и пиктограммой. Пример на стенде приседаний: колени завалились внутрь — игра обводит ошибку и говорит «Колени наружу!»; следующий повтор чистый — «+2». Отжимание засчитывается только с правильной техникой — одно очко клятвы; приседание в «Новичке» — очко, чистое — два, в «Мастере» засчитываются только чистые. Очки открывают 7 улучшений героя. Живой показ — с сайта или через serve_game.py (из файла игра не стартует); приседания вживую: «Клятва героя» → «Тренировка» → «Приседания».</aside>
</section>`
  });

  /* ---------- 12. Кому это нужно и что дальше ---------- */
  // Три карточки переворачиваются по шагам (rotateY 450 мс): рубашка с орнаментом игры → лицо с текстом.
  var CARDS = [
    ['Школа', 'без установки, офлайн,&nbsp;LAN'],
    ['Дом', 'контроль техники приседаний и&nbsp;отжиманий'],
    ['Доступность', 'можно сидя; «Новичок»&nbsp;— 5&nbsp;базовых жестов и&nbsp;автоход; без&nbsp;мыши']
  ];
  Q.push({
    n: 12, sec: 40,
    html: `<section class="slide" data-slide="12" data-title="Кому это нужно и что дальше">
  <p class="kicker">Применение</p>
  <h2 class="thesis">Кому это нужно и&nbsp;что дальше</h2>
  <div class="p2-body">
    <ul class="p2-who">
      ${CARDS.map(function (c, i) {
        return '<li class="p2-card" data-step="' + (i + 1) + '"><div class="p2-face p2-face--front"><h3>' + c[0] + '</h3><p>' + c[1] + '</p></div>' +
          '<div class="p2-face p2-face--back" aria-hidden="true"><i class="p2-sigil"></i></div></li>';
      }).join('')}
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
