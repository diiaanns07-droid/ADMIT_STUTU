/* ASHEN OATH — слайды 1, 2 и 13: титул, проблема, клятва (сигнатурный момент). */

// Команда: имя и роль. Пустую роль не выводим. Отредактируйте перед выступлением — слайд 13 соберётся сам.
var TEAM = [
  { name: 'Damir', role: '' },
  { name: 'diiaanns07-droid', role: '' }
];

(function () {
  'use strict';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  // Буквы логотипа по отдельности: разрядка «сходится» сдвигом букв (transform), а не анимацией letter-spacing.
  function letters(word) {
    return word.split('').map(function (c, i) { return '<span style="--i:' + i + '">' + c + '</span>'; }).join('');
  }

  // Сигил из заставки игры (modules/ui.js, ICONS.sigil).
  var SIGIL =
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<circle cx="32" cy="32" r="21"/><circle cx="32" cy="32" r="16" stroke-opacity=".45"/>' +
    '<path d="M32 9v46"/><path d="M24.5 39.5 32 45l7.5-5.5"/>' +
    '<path d="M32 19.5c3.2 3 3.6 6.2 0 9.8-3.6-3.6-3.2-6.8 0-9.8z" fill="currentColor" fill-opacity=".28"/>' +
    '<path d="M11 32h6M47 32h6" stroke-opacity=".7"/></svg>';

  // Иконки слайда 2: 48 px, золотая линия 2 px.
  var ICON = {
    vr: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 17a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4h-8.6a3 3 0 0 1-2.8-2l-1-2.7a2.8 2.8 0 0 0-5.2 0l-1 2.7a3 3 0 0 1-2.8 2H10a4 4 0 0 1-4-4z"/><path d="M6 20.5H3v6h3M42 20.5h3v6h-3"/><path d="M14 13V9.5h20V13"/></svg>',
    gym: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M3 24h5M40 24h5M14 24h20"/><rect x="8" y="15" width="6" height="18" rx="1.5"/><rect x="34" y="15" width="6" height="18" rx="1.5"/></svg>',
    desk: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="14" width="25" height="17" rx="1.5"/><path d="M1.5 35h30l-1.5 3H3z"/><circle cx="37" cy="14" r="8"/><path d="M37 9.5V14l3 2"/></svg>'
  };

  // QR (версия 4, коррекция M) на https://diiaanns07-droid.github.io/ADMIT_STUTU/ — модулями SVG, без внешних сервисов (из v1.html).
  var QR_PATH = 'M4 4h7v1h-7zM13 4h3v1h-3zM18 4h1v1h-1zM20 4h1v1h-1zM22 4h3v1h-3zM27 4h1v1h-1zM30 4h7v1h-7zM4 5h1v1h-1zM10 5h1v1h-1zM15 5h2v1h-2zM19 5h1v1h-1zM22 5h1v1h-1zM25 5h2v1h-2zM30 5h1v1h-1zM36 5h1v1h-1zM4 6h1v1h-1zM6 6h3v1h-3zM10 6h1v1h-1zM12 6h1v1h-1zM18 6h2v1h-2zM23 6h1v1h-1zM25 6h1v1h-1zM28 6h1v1h-1zM30 6h1v1h-1zM32 6h3v1h-3zM36 6h1v1h-1zM4 7h1v1h-1zM6 7h3v1h-3zM10 7h1v1h-1zM12 7h1v1h-1zM14 7h2v1h-2zM22 7h1v1h-1zM26 7h1v1h-1zM28 7h1v1h-1zM30 7h1v1h-1zM32 7h3v1h-3zM36 7h1v1h-1zM4 8h1v1h-1zM6 8h3v1h-3zM10 8h1v1h-1zM12 8h3v1h-3zM18 8h4v1h-4zM24 8h1v1h-1zM26 8h3v1h-3zM30 8h1v1h-1zM32 8h3v1h-3zM36 8h1v1h-1zM4 9h1v1h-1zM10 9h1v1h-1zM12 9h2v1h-2zM16 9h1v1h-1zM18 9h1v1h-1zM21 9h1v1h-1zM23 9h1v1h-1zM26 9h2v1h-2zM30 9h1v1h-1zM36 9h1v1h-1zM4 10h7v1h-7zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM18 10h1v1h-1zM20 10h1v1h-1zM22 10h1v1h-1zM24 10h1v1h-1zM26 10h1v1h-1zM28 10h1v1h-1zM30 10h7v1h-7zM12 11h1v1h-1zM14 11h3v1h-3zM18 11h1v1h-1zM20 11h1v1h-1zM23 11h3v1h-3zM28 11h1v1h-1zM4 12h1v1h-1zM6 12h5v1h-5zM14 12h5v1h-5zM21 12h1v1h-1zM23 12h2v1h-2zM26 12h3v1h-3zM30 12h5v1h-5zM4 13h1v1h-1zM6 13h1v1h-1zM13 13h2v1h-2zM16 13h2v1h-2zM20 13h6v1h-6zM27 13h1v1h-1zM30 13h2v1h-2zM33 13h2v1h-2zM36 13h1v1h-1zM4 14h1v1h-1zM6 14h2v1h-2zM9 14h3v1h-3zM13 14h2v1h-2zM16 14h4v1h-4zM21 14h1v1h-1zM25 14h2v1h-2zM30 14h1v1h-1zM32 14h1v1h-1zM34 14h2v1h-2zM5 15h1v1h-1zM7 15h3v1h-3zM11 15h1v1h-1zM13 15h2v1h-2zM17 15h1v1h-1zM19 15h4v1h-4zM24 15h1v1h-1zM26 15h1v1h-1zM28 15h2v1h-2zM32 15h4v1h-4zM5 16h1v1h-1zM10 16h1v1h-1zM12 16h1v1h-1zM14 16h1v1h-1zM18 16h3v1h-3zM24 16h3v1h-3zM28 16h2v1h-2zM31 16h1v1h-1zM33 16h1v1h-1zM36 16h1v1h-1zM4 17h3v1h-3zM9 17h1v1h-1zM11 17h4v1h-4zM16 17h2v1h-2zM19 17h1v1h-1zM21 17h2v1h-2zM28 17h2v1h-2zM33 17h1v1h-1zM35 17h2v1h-2zM4 18h3v1h-3zM8 18h1v1h-1zM10 18h4v1h-4zM19 18h2v1h-2zM22 18h1v1h-1zM24 18h1v1h-1zM26 18h1v1h-1zM29 18h2v1h-2zM33 18h1v1h-1zM35 18h1v1h-1zM4 19h1v1h-1zM7 19h1v1h-1zM12 19h1v1h-1zM14 19h1v1h-1zM18 19h2v1h-2zM25 19h1v1h-1zM29 19h2v1h-2zM32 19h1v1h-1zM34 19h1v1h-1zM4 20h2v1h-2zM7 20h1v1h-1zM9 20h5v1h-5zM18 20h4v1h-4zM26 20h1v1h-1zM28 20h2v1h-2zM31 20h2v1h-2zM36 20h1v1h-1zM4 21h1v1h-1zM6 21h2v1h-2zM9 21h1v1h-1zM14 21h1v1h-1zM18 21h1v1h-1zM20 21h1v1h-1zM22 21h6v1h-6zM30 21h2v1h-2zM33 21h2v1h-2zM36 21h1v1h-1zM8 22h1v1h-1zM10 22h1v1h-1zM13 22h2v1h-2zM17 22h1v1h-1zM19 22h2v1h-2zM22 22h1v1h-1zM24 22h3v1h-3zM29 22h1v1h-1zM31 22h2v1h-2zM34 22h2v1h-2zM4 23h1v1h-1zM7 23h2v1h-2zM12 23h1v1h-1zM16 23h4v1h-4zM24 23h2v1h-2zM28 23h1v1h-1zM31 23h4v1h-4zM36 23h1v1h-1zM5 24h4v1h-4zM10 24h4v1h-4zM15 24h1v1h-1zM17 24h2v1h-2zM22 24h2v1h-2zM25 24h1v1h-1zM27 24h1v1h-1zM29 24h1v1h-1zM31 24h1v1h-1zM33 24h1v1h-1zM35 24h2v1h-2zM4 25h5v1h-5zM12 25h1v1h-1zM15 25h2v1h-2zM18 25h3v1h-3zM24 25h2v1h-2zM27 25h3v1h-3zM33 25h1v1h-1zM36 25h1v1h-1zM4 26h1v1h-1zM6 26h7v1h-7zM14 26h2v1h-2zM23 26h1v1h-1zM28 26h2v1h-2zM31 26h1v1h-1zM33 26h1v1h-1zM35 26h1v1h-1zM4 27h1v1h-1zM7 27h2v1h-2zM13 27h3v1h-3zM20 27h1v1h-1zM22 27h5v1h-5zM28 27h1v1h-1zM33 27h3v1h-3zM4 28h1v1h-1zM6 28h1v1h-1zM8 28h3v1h-3zM12 28h1v1h-1zM16 28h2v1h-2zM21 28h3v1h-3zM28 28h5v1h-5zM34 28h1v1h-1zM36 28h1v1h-1zM12 29h2v1h-2zM17 29h1v1h-1zM20 29h4v1h-4zM26 29h1v1h-1zM28 29h1v1h-1zM32 29h1v1h-1zM34 29h1v1h-1zM36 29h1v1h-1zM4 30h7v1h-7zM13 30h2v1h-2zM16 30h1v1h-1zM19 30h3v1h-3zM24 30h1v1h-1zM26 30h3v1h-3zM30 30h1v1h-1zM32 30h1v1h-1zM34 30h1v1h-1zM4 31h1v1h-1zM10 31h1v1h-1zM12 31h1v1h-1zM15 31h3v1h-3zM20 31h5v1h-5zM27 31h2v1h-2zM32 31h3v1h-3zM36 31h1v1h-1zM4 32h1v1h-1zM6 32h3v1h-3zM10 32h1v1h-1zM12 32h3v1h-3zM17 32h4v1h-4zM24 32h3v1h-3zM28 32h6v1h-6zM4 33h1v1h-1zM6 33h3v1h-3zM10 33h1v1h-1zM12 33h1v1h-1zM14 33h2v1h-2zM17 33h3v1h-3zM21 33h2v1h-2zM25 33h1v1h-1zM27 33h3v1h-3zM32 33h1v1h-1zM34 33h1v1h-1zM36 33h1v1h-1zM4 34h1v1h-1zM6 34h3v1h-3zM10 34h1v1h-1zM12 34h2v1h-2zM15 34h7v1h-7zM24 34h2v1h-2zM30 34h2v1h-2zM33 34h2v1h-2zM4 35h1v1h-1zM10 35h1v1h-1zM13 35h1v1h-1zM15 35h2v1h-2zM19 35h1v1h-1zM22 35h1v1h-1zM25 35h1v1h-1zM29 35h2v1h-2zM32 35h3v1h-3zM4 36h7v1h-7zM12 36h1v1h-1zM16 36h1v1h-1zM18 36h2v1h-2zM21 36h1v1h-1zM24 36h1v1h-1zM28 36h4v1h-4zM34 36h2v1h-2z';

  function team() {
    return TEAM.filter(function (m) { return m && m.name; }).map(function (m) {
      return '<li class="s13__member"><span class="s13__name">' + esc(m.name) + '</span>' +
        (m.role ? '<span class="s13__role">' + esc(m.role) + '</span>' : '') + '</li>';
    }).join('');
  }

  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  /* ---------- 1. Титул */
  var t1 = 0;
  Q.push({
    n: 1, sec: 20,
    html: `<section class="slide s1" data-slide="1" data-title="ASHEN OATH">
      <div class="s1__art" aria-hidden="true"><img src="media/p1/arena-far.jpg" alt="" width="956" height="508"></div>
      <p class="kicker">Финал ADMIT · кейс Motion</p>
      <div class="s1__body">
        <h1 class="s1__logo" lang="en" aria-label="ASHEN OATH">
          <span class="s1__word" aria-hidden="true">${letters('ASHEN')}</span>
          <span class="s1__rule" aria-hidden="true"><span class="s1__sigil">${SIGIL}</span></span>
          <span class="s1__word" aria-hidden="true">${letters('OATH')}</span>
        </h1>
        <p class="s1__tag">Камера вместо джойстика</p>
        <p class="lead s1__lead">Тёмное фэнтези в браузере. Управление телом и руками через обычную веб-камеру.</p>
      </div>
      <aside class="notes">ASHEN OATH — игра, в которой контроллер — это вы. Обычный ноутбук, веб-камера, ссылка — и вы сражаетесь с боссом руками и телом. Ничего не нужно устанавливать. За восемь минут покажем, как это работает и что изменилось со 2 октября.</aside>
    </section>`,
    // Логотип проявляется за 600 мс (буквы сходятся от разрядки .24em к .17em), строки ниже — через 300 мс.
    // Анимируем при первом открытии и при входе вперёд; назад, по hash и с «уменьшенным движением» — сразу итог.
    enter: function (el, dir, info) {
      clearTimeout(t1);
      el.classList.remove('is-intro', 'is-play');
      if ((dir > 0 || info.prev === null) && !reduced()) {
        el.classList.add('is-intro');
        void el.offsetWidth;
        el.classList.add('is-play');
        t1 = setTimeout(function () { el.classList.remove('is-intro', 'is-play'); }, 1200);
      }
    },
    leave: function (el) { clearTimeout(t1); el.classList.remove('is-intro', 'is-play'); }
  });

  /* ---------- 2. Проблема */
  Q.push({
    n: 2, sec: 30,
    html: `<section class="slide s2" data-slide="2" data-title="Игры с движением требуют железа — а камера уже есть">
      <p class="kicker">Проблема</p>
      <h2 class="thesis">Игры с движением требуют железа — а&nbsp;камера уже есть</h2>
      <ol class="s2__list">
        <li class="s2__item" data-step="1"><span class="s2__icon">${ICON.vr}</span><p>Приставки и&nbsp;VR дорогие и&nbsp;есть не&nbsp;у&nbsp;всех.</p></li>
        <li class="s2__item" data-step="2"><span class="s2__icon">${ICON.gym}</span><p>Фитнес-приложения скучны&nbsp;— их&nbsp;бросают.</p></li>
        <li class="s2__item" data-step="3"><span class="s2__icon">${ICON.desk}</span><p>Мы часами сидим за&nbsp;ноутбуком.</p></li>
      </ol>
      <p class="s2__turn" data-step="4">Веб-камера уже есть в каждом ноутбуке.</p>
      <aside class="notes">Игры с движением упираются в железо: приставку, VR, датчики. Тренировки дома скучные, их бросают. При этом камера уже стоит в каждом ноутбуке и в каждом школьном классе. Мы решили сделать её джойстиком.</aside>
    </section>`
  });

  /* ---------- 13. Клятва — сигнатурный момент */
  var t13 = [];
  function clear13() { t13.forEach(clearTimeout); t13 = []; }
  Q.push({
    n: 13, sec: 25,
    html: `<section class="slide s13" data-slide="13" data-title="Наша клятва">
      <div class="s13__bg" aria-hidden="true"><img src="../docs/screenshots/kino/7_death_orbit.jpg" alt="" width="1280" height="720"></div>
      <p class="kicker">Клятва</p>
      <div class="s13__main">
        <h2 class="thesis s13__oath">Любой ноутбук с&nbsp;камерой — игра, тренер и&nbsp;урок движения.</h2>
        <p class="s13__hands">Ваши руки — это джойстик. Сыграйте сами.</p>
        <div class="s13__row">
          <a class="s13__live" href="../index.html?demo&amp;present&amp;fury=100" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>Живой показ</a>
          <ul class="s13__team" aria-label="Команда">${team()}</ul>
        </div>
      </div>
      <figure class="s13__qr">
        <div class="s13__code"><svg viewBox="0 0 41 41" role="img" aria-label="QR-код: https://diiaanns07-droid.github.io/ADMIT_STUTU/"><rect width="41" height="41"/><path d="${QR_PATH}"/></svg></div>
        <figcaption class="s13__url"><span>diiaanns07-droid.github.io</span><span>/ADMIT_STUTU</span></figcaption>
      </figure>
      <p class="src s13__src">three.js · MediaPipe (Google) · three-vrm (pixiv) · PeerJS · Quaternius · KayKit · VRoid · Poly Haven · Google Fonts (OFL). Звук и мир — свои.</p>
      <aside class="notes">Наша клятва простая: любой ноутбук с камерой — это игра, тренер и урок движения. Отсканируйте QR — игра откроется в браузере. Сейчас покажем вживую. Спасибо!</aside>
    </section>`,
    // Вперёд с 12-го: deck.js опустошает полосу Регента и рассыпает её угольками (0–1,7 с),
    // строка клятвы проявляется слева направо (1,1–1,9 с), строка про руки — следом (до 2,2 с).
    // По hash, назад, с «уменьшенным движением» и в печати — сразу конечное состояние.
    enter: function (el, dir, info) {
      clear13();
      el.classList.remove('is-sig', 'is-oath');
      if (dir > 0 && info.prev === 12 && !reduced()) {
        el.classList.add('is-sig');
        void el.offsetWidth;
        t13.push(setTimeout(function () { el.classList.add('is-oath'); }, 1100));
        t13.push(setTimeout(function () { el.classList.remove('is-sig', 'is-oath'); }, 2600));
      }
    },
    leave: function (el) { clear13(); el.classList.remove('is-sig', 'is-oath'); }
  });
})();
