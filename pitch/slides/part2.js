/* ASHEN OATH — презентация финала, слайды 4–7 (управление и режим «ОШИБКА») и 12.
 * Обычный скрипт без модулей и сетевых запросов: работает и из file://.
 * Слайды регистрируются в общей очереди DECK_QUEUE, её разбирает deck.js.
 * Метка раздела и тезис стоят прямо в слайде (их место задаёт deck.css), содержимое — в .p2-body (полоса 260–960).
 * Схемы на 4 и 6 — интерактивные: этапы идут по шагам доклада или кнопками на слайде; вход назад, переход по hash,
 * «уменьшенное движение» и печать — сразу конечный этап. */
(function () {
  'use strict';
  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  // Орнаментальная рамка поверх кадра (класс .frame из deck.css): отдельным слоем, чтобы уголки не прятались под картинкой
  var RING = '<i class="frame p2-ring" aria-hidden="true"></i>';

  /* ---------- Кисть: 21 точка MediaPipe Hands (те же координаты, что в схеме слайдов 7–11) ---------- */
  // 0 — запястье; 1–4 большой; 5–8 указательный; 9–12 средний; 13–16 безымянный; 17–20 мизинец
  var HP = [[150,320],[105,295],[75,260],[55,228],[40,198],[115,190],[108,140],[104,108],[100,78],[150,185],[150,130],[150,95],[150,62],[183,192],[190,142],[194,110],[197,82],[212,208],[225,170],[233,146],[240,122]];
  var HB = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
  // «OK» правой: указательный загнут к большому, остальные прямо. NEAR — кончики 4 и 8 не сомкнуты, OK — сомкнуты.
  function pose(over) { return HP.map(function (p, i) { return over[i] || p; }); }
  var NEAR = pose({ 1: [108,290], 2: [82,258], 3: [66,226], 4: [58,196], 6: [100,150], 7: [80,132], 8: [64,146] });
  var OK = pose({ 1: [108,290], 2: [82,258], 3: [66,226], 4: [58,196], 6: [98,152], 7: [76,156], 8: [62,188] });

  // Кисть в SVG: кости и точки; k — масштаб, (cx, cy) — куда встаёт центр кисти (140, 191)
  function hand(P, k, cx, cy, cls) {
    function q(i) { return [(cx + (P[i][0] - 140) * k).toFixed(1), (cy + (P[i][1] - 191) * k).toFixed(1)]; }
    return '<g class="p2-hand ' + (cls || '') + '"><g class="p2-hand-bones">' + HB.map(function (b, j) {
      var a = q(b[0]), c = q(b[1]);
      return '<line style="--j:' + j + '" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + c[0] + '" y2="' + c[1] + '"/>';
    }).join('') + '</g><g class="p2-hand-pts">' + P.map(function (_, i) {
      var a = q(i);
      return '<circle class="p2-pt p2-pt--' + i + '" style="--i:' + i + '" cx="' + a[0] + '" cy="' + a[1] + '" r="' + (i % 4 === 0 ? 7 : 5.5) + '"/>';
    }).join('') + '</g></g>';
  }
  function at(P, i, k, cx, cy) { return [cx + (P[i][0] - 140) * k, cy + (P[i][1] - 191) * k]; }

  /* ---------- Интерактивная схема: этапы по шагам доклада или кнопками ---------- */
  // На слайде классы p2-st1…p2-stN (накопительно). Скрытые метки data-step нужны движку, чтобы считать шаги.
  function stager(N, AUTO_MS) {
    var st = { k: 0, t: 0 };
    function set(el, k) {
      st.k = Math.max(0, Math.min(N, k));
      for (var i = 1; i <= N; i++) el.classList.toggle('p2-st' + i, i <= st.k);
      el.setAttribute('data-p2-stage', st.k);
    }
    function stop() { clearTimeout(st.t); st.t = 0; }
    function run(el) {
      stop();
      if (st.k >= N) set(el, 0);
      (function tick() { set(el, st.k + 1); if (st.k < N) st.t = setTimeout(tick, AUTO_MS); else st.t = 0; })();
    }
    return {
      enter: function (el, dir) {
        stop(); set(el, dir < 0 ? N : 0);
        if (el.__p2) return;
        el.__p2 = true;
        el.addEventListener('click', function (e) {
          var b = e.target.closest && e.target.closest('[data-p2]');
          if (!b) return;
          var a = b.getAttribute('data-p2');
          if (a === 'run') run(el); else { stop(); set(el, a === 'next' ? st.k + 1 : 0); }
        });
        window.addEventListener('beforeprint', function () { stop(); set(el, N); });
      },
      step: function (el, k) { stop(); if (k > st.k) set(el, k); },
      leave: function () { stop(); }
    };
  }
  function marks(N) { var s = ''; for (var i = 1; i <= N; i++) s += '<i class="p2-mark" data-step="' + i + '" aria-hidden="true"></i>'; return s; }
  function buttons(list) {
    return '<div class="p2-ctl" data-interactive>' + list.map(function (b) {
      return '<button type="button" class="p2-btn' + (b[2] ? ' p2-btn--main' : '') + '" data-p2="' + b[0] + '">' + b[1] + '</button>';
    }).join('') + '</div>';
  }

  /* ---------- 4. Как рука становится командой ---------- */
  // Конвейер распознавания (core/handGestures.js): кадр → 21 точка → геометрия → автомат состояний → действие.
  var S4 = stager(5, 1100);
  var K4 = 1.5, CX4 = 330, CY4 = 232;          // кисть на «экране» схемы (1680×470)
  var palm = [0, 5, 9, 13, 17].reduce(function (a, i) { var p = at(HP, i, K4, CX4, CY4); return [a[0] + p[0] / 5, a[1] + p[1] / 5]; }, [0, 0]);
  var STAGES4 = ['Кадр камеры', '21&nbsp;точка кисти', 'Геометрия', 'Автомат состояний', 'Действие'];
  Q.push({
    n: 4, sec: 50,
    html: `<section class="slide" data-slide="4" data-title="Как рука становится командой">
  <p class="kicker">Кейс Motion · как это работает</p>
  <h2 class="thesis">Как рука становится командой</h2>
  <div class="p2-body">
    ${marks(5)}
    <ol class="p2-pipe">
      ${STAGES4.map(function (t, i) { return '<li class="p2-pipe-n p2-pn' + (i + 1) + '"><b>' + (i + 1) + '</b><span>' + t + '</span></li>'; }).join('')}
      <li class="p2-pipe-line" aria-hidden="true"><i></i></li>
    </ol>
    <figure class="p2-shot p2-s4-screen">
      <div class="p2-crop p2-screen">
        <svg class="p2-s4-svg" viewBox="0 0 1662 452" aria-hidden="true" focusable="false">
          <g class="p2-cam">
            <rect x="70" y="18" width="520" height="416" rx="10"/>
            <path d="M70 70V18h52M538 18h52v52M590 382v52h-52M122 434H70v-52"/>
            <g class="p2-cam-blur">${HB.map(function (b) { var a = at(HP, b[0], K4, CX4, CY4), c = at(HP, b[1], K4, CX4, CY4); return '<line x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) + '" x2="' + c[0].toFixed(1) + '" y2="' + c[1].toFixed(1) + '"/>'; }).join('')}</g>
          </g>
          ${hand(HP, K4, CX4, CY4, 'p2-s4-hand')}
          <g class="p2-geo">
            ${[6, 10, 14].map(function (i) { var p = at(HP, i, K4, CX4, CY4); return '<circle class="p2-geo-arc" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="17"/>'; }).join('')}
            <circle class="p2-geo-n0" cx="${palm[0].toFixed(1)}" cy="${palm[1].toFixed(1)}" r="12"/><circle class="p2-geo-n1" cx="${palm[0].toFixed(1)}" cy="${palm[1].toFixed(1)}" r="4"/>
            <path class="p2-geo-v" d="M500 330h60M500 350h86M500 370h60"/><path class="p2-geo-va" d="M586 350l-14-9v18z"/>
            <path class="p2-geo-lead" d="M${(at(HP, 10, K4, CX4, CY4)[0] + 18).toFixed(0)} ${at(HP, 10, K4, CX4, CY4)[1].toFixed(0)}H640M${(palm[0] + 14).toFixed(0)} ${palm[1].toFixed(0)}H640M590 350H640"/>
            <text x="652" y="${(at(HP, 10, K4, CX4, CY4)[1] + 9).toFixed(0)}">сгибы пальцев</text>
            <text x="652" y="${(palm[1] + 9).toFixed(0)}">нормаль ладони</text>
            <text x="652" y="359">скорость</text>
          </g>
          <g class="p2-fsm">
            <g class="p2-fsm-n"><rect x="900" y="186" width="200" height="84" rx="42"/><text x="1000" y="238">Кулак</text></g>
            <path class="p2-fsm-a" d="M1104 228H1172"/><path class="p2-fsm-h" d="M1180 228l-14-9v18z"/>
            <g class="p2-fsm-n"><rect x="1184" y="186" width="230" height="84" rx="42"/><text x="1299" y="238">Раскрыть резко</text></g>
            <path class="p2-fsm-a" d="M1418 228H1470"/><path class="p2-fsm-h" d="M1478 228l-14-9v18z"/>
            <g class="p2-fsm-out"><rect x="1482" y="186" width="160" height="84" rx="10"/><text x="1562" y="238">Выброс</text></g>
            <circle class="p2-fsm-dot" cx="1104" cy="228" r="7"/>
          </g>
          <g class="p2-act">
            <image href="media/p2/burst.jpg" x="882" y="64" width="760" height="299" preserveAspectRatio="xMidYMid slice"/>
            <rect class="p2-act-ring" x="882" y="64" width="760" height="299"/>
          </g>
        </svg>
      </div>
      ${RING}
    </figure>
    ${buttons([['run', 'Запустить', true], ['next', 'Дальше'], ['reset', 'Сначала']])}
    <p class="cap p2-s4-cap">В&nbsp;браузере · 0&nbsp;кадров в&nbsp;сеть · 21&nbsp;точка × 2 + поза</p>
  </div>
  <aside class="notes">Как рука становится командой. Камера даёт кадр — он не уходит в сеть. MediaPipe прямо в браузере ставит 21 точку на каждую кисть и ещё точки позы. Дальше наш код считает геометрию: насколько согнут каждый палец, куда смотрит ладонь — её нормаль, и как быстро движется кисть. Автомат состояний ждёт последовательность: кулак подержали, потом резко раскрыли — это «Выброс», и он летит в Регента. Кнопками «Запустить», «Дальше», «Сначала» можно пройти этапы ещё раз.</aside>
</section>`,
    enter: S4.enter, step: S4.step, leave: S4.leave
  });

  /* ---------- 5. Левая — движение, правая — магия ---------- */
  // Клип «Дух игрока» (docs/video/spirit.mp4, 0–8,6 с). Справа внизу кадра игра сама пишет, что делает каждая рука
  // («ЛЕВАЯ: …», «ПРАВАЯ: …»): от этих строк к подписям по шагам прочерчиваются золотые выноски, подпись — следом.
  // Координаты выносок — в системе .p2-body (1680×700): строки состояния рук — x 1022, y 496 и 516.
  Q.push({
    n: 5, sec: 40,
    html: `<section class="slide" data-slide="5" data-title="Левая — движение, правая — магия">
  <p class="kicker">Управление</p>
  <h2 class="thesis">Левая — движение, правая — магия</h2>
  <div class="p2-body">
    <figure class="p2-shot p2-s5-shot">
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
      <li class="p2-tick p2-tick--l" data-step="1"><span class="p2-tick-k">Левая рука</span><span class="p2-tick-t">ход, рывок, щит</span></li>
      <li class="p2-tick p2-tick--r" data-step="2"><span class="p2-tick-k">Правая</span><span class="p2-tick-t">снаряды, выброс, руны</span></li>
      <li class="p2-tick p2-tick--b" data-step="3"><span class="p2-tick-k">Две руки</span><span class="p2-tick-t">сфера, печати, «Врата бури»</span></li>
    </ol>
    <p class="p2-s5-num"><span class="num" data-ignite>24</span><span class="unit">жеста</span></p>
  </div>
  <aside class="notes">Справа внизу игра пишет, что сейчас делает каждая рука, и цвет тот же, что в интерфейсе. Левая — синяя, это движение: ход и бег, рывок с неуязвимостью, щит — резкий толчок ладонью к камере. Правая — оранжевая, это магия: снаряды жестом «OK», выброс — кулак резко раскрыть, руны указательным пальцем. Двумя руками собирают сферу, ставят печати и открывают «Врата бури». Всего 24 жеста, у каждого своё действие. Ролик снят с клавиатуры, живую камеру покажем на демо.</aside>
</section>`
  });

  /* ---------- 6. Не «не распознано», а «что исправить» ---------- */
  // Почти правильное «OK»: кончики большого и указательного не сомкнуты. Этап 1 — игра подсвечивает, чего не хватает,
  // и выводит свою подсказку (core/gestureCoach.js, ok_ring_open); этап 2 — пальцы смыкаются, «Распознано».
  var S6 = stager(2, 1400);
  var K6 = 1.4, CX6 = 300, CY6 = 228;
  var t4 = at(NEAR, 4, K6, CX6, CY6), t8 = at(NEAR, 8, K6, CX6, CY6), gap = [(t4[0] + t8[0]) / 2, (t4[1] + t8[1]) / 2];
  Q.push({
    n: 6, sec: 45,
    html: `<section class="slide" data-slide="6" data-title="Не «не распознано», а «что исправить»">
  <p class="kicker">Твист кейса · ОШИБКА</p>
  <h2 class="thesis">Не «не распознано», а&nbsp;«что исправить»</h2>
  <div class="p2-body">
    ${marks(2)}
    <figure class="p2-shot p2-s6-hand">
      <div class="p2-crop p2-screen">
        <svg class="p2-s6-svg" viewBox="0 0 582 452" aria-hidden="true" focusable="false">
          ${hand(NEAR, K6, CX6, CY6, 'p2-near')}
          ${hand(OK, K6, CX6, CY6, 'p2-ok')}
          <circle class="p2-gap" cx="${gap[0].toFixed(1)}" cy="${gap[1].toFixed(1)}" r="44" pathLength="1"/>
          <circle class="p2-ring-ok" cx="${at(OK, 4, K6, CX6, CY6)[0].toFixed(1)}" cy="${(at(OK, 4, K6, CX6, CY6)[1] - 22).toFixed(1)}" r="40" pathLength="1"/>
        </svg>
      </div>
      ${RING}
      <figcaption class="src p2-fig-note">Схема по&nbsp;21&nbsp;точке кисти</figcaption>
    </figure>
    <div class="p2-verdict">
      <p class="p2-card-err"><span class="p2-card-k">Ошибка · «OK» · снаряд</span><span class="p2-card-t">Сомкни кончики большого и&nbsp;указательного в&nbsp;кольцо</span></p>
      <p class="p2-card-ok"><span class="p2-card-k">Распознано</span><span class="p2-card-t">«OK» — снаряды летят</span></p>
    </div>
    ${buttons([['next', 'Дальше', true], ['reset', 'Сначала']])}
    <figure class="p2-shot p2-s6-proof">
      <div class="p2-crop"><img src="../docs/screenshots/spirit/09_battle_mistake.jpg" alt="Бой: та же подсказка «Сомкни кончики большого и указательного в кольцо» в окне «ОШИБКА»" decoding="async"></div>
      ${RING}
      <figcaption class="src p2-fig-note">Та же подсказка в&nbsp;бою · снято с&nbsp;клавиатуры</figcaption>
    </figure>
    <div class="p2-s6-hint">
      <span class="num" data-ignite>63</span>
      <p class="p2-s6-what"><span class="unit">подсказки</span><span class="cap">49 к&nbsp;жестам · 14 к&nbsp;технике</span></p>
    </div>
  </div>
  <aside class="notes">Жест почти правильный: «OK», но кончики большого и указательного не сомкнуты. Обычная система скажет «не распознано». Наша подсвечивает, чего не хватает, и говорит, что исправить: «Сомкни кончики большого и указательного в кольцо» — та же подсказка, что в бою справа. Пальцы сомкнулись — «Распознано», снаряды летят. Таких подсказок 63: 49 к жестам и 14 к технике приседаний и отжиманий, голосом и пиктограммой.</aside>
</section>`,
    enter: S6.enter, step: S6.step, leave: S6.leave
  });

  /* ---------- 7. Тренер техники ---------- */
  // Стенд приседаний (dev/squat_stand.html, камера низко, симуляция позы): шаг 1 — колени завалились внутрь,
  // вокруг них прочерчивается красный круг и печатается голосовая подсказка игры «Колени наружу!»
  // (core/voicePhrases.js, valgus); шаг 2 — тот же ракурс, чистый повтор: золотое свечение и «+2» («Новичок»).
  Q.push({
    n: 7, sec: 40,
    html: `<section class="slide" data-slide="7" data-title="Тренер техники">
  <p class="kicker">Клятва героя · приседания и&nbsp;отжимания</p>
  <h2 class="thesis">Тренер, который видит технику</h2>
  <div class="p2-body">
    <figure class="p2-shot p2-s7-sq">
      <div class="p2-crop">
        <img class="p2-sq-in" src="media/p2/squat_in.jpg" alt="Стенд приседаний: колени завалились внутрь" decoding="async">
        <img class="p2-sq-out" data-step="2" src="media/p2/squat_out.jpg" alt="Тот же ракурс: чистый повтор, колени по линии носков" decoding="async">
        <i class="p2-sq-glow" data-step="2" aria-hidden="true"></i>
        <svg class="p2-knees" viewBox="0 0 400 360" aria-hidden="true" focusable="false"><ellipse data-step="1" cx="194" cy="196" rx="48" ry="40" pathLength="1"/></svg>
      </div>
      ${RING}
      <figcaption class="cap p2-fig-note">Стенд; с&nbsp;камерой — на&nbsp;живом показе.</figcaption>
    </figure>
    <ol class="p2-s7-story">
      <li class="p2-tick p2-tick--err" data-step="1"><span class="p2-tick-k">Колени внутрь</span><span class="p2-say"><span class="p2-say-t">«Колени наружу!»</span></span></li>
      <li class="p2-tick p2-tick--gold" data-step="2"><span class="p2-tick-k">Чистый повтор</span><span class="p2-plus"><span class="num">+2</span><span class="unit">очка клятвы</span></span></li>
    </ol>
    <p class="lead p2-s7-line">7&nbsp;улучшений героя за&nbsp;очки клятвы</p>
  </div>
  <aside class="notes">Тот же принцип в тренировке. Стенд приседаний: колени завалились внутрь — игра обводит ошибку и говорит голосом «Колени наружу!». Следующий повтор чистый — плюс два очка клятвы. В «Новичке» повтор с ошибкой — очко, чистый — два; в «Мастере» засчитываются только чистые; отжимание — только с правильной техникой, одно очко. За очки открываются 7 улучшений героя. Приседания вживую: «Клятва героя» → «Тренировка» → «Приседания».</aside>
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
