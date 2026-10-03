/* ASHEN OATH — слайды 1, 2 и 13: титул, проблема, клятва (сигнатурный момент). */
(function () {
  'use strict';

  // Команда: ФИО и роль, например { name: 'Имя Фамилия', role: 'код и бой' }. Пустую роль не выводим;
  // пока массив пуст, блока «Команда» на слайде 13 нет. Заполните перед выступлением — слайд соберётся сам.
  var TEAM = [];

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

  // QR игры лежит в index.html (<template id="qr-game">, его же сверяет dev/challenge.test.mjs) — клонируем на слайд 13.
  function qr() {
    var tpl = document.getElementById('qr-game');
    if (!tpl) { console.warn('Слайд 13: нет <template id="qr-game"> в index.html'); return ''; }
    var box = document.createElement('div');
    box.appendChild(tpl.content.cloneNode(true));
    return box.innerHTML;
  }

  function team() {
    var list = TEAM.filter(function (m) { return m && m.name; });
    if (!list.length) return '';
    return '<div class="s13__team"><p class="s13__team-k">Команда</p><ul class="s13__people">' + list.map(function (m) {
      return '<li class="s13__member"><span class="s13__name">' + esc(m.name) + '</span>' +
        (m.role ? '<span class="s13__role">' + esc(m.role) + '</span>' : '') + '</li>';
    }).join('') + '</ul></div>';
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
      <div class="s13__bg" aria-hidden="true"><img src="media/p1/oath-bg.jpg" alt="" width="1920" height="1080"></div>
      <p class="kicker">Клятва</p>
      <div class="s13__main">
        <h2 class="thesis s13__oath">Любой ноутбук с&nbsp;камерой — игра, тренер и&nbsp;урок движения.</h2>
        <p class="s13__hands">Ваши руки — это джойстик. Сыграйте сами.</p>
        <div class="s13__row">
          <a class="s13__live" href="../index.html?demo&amp;present&amp;fury=100" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>Живой показ</a>
          ${team()}
        </div>
      </div>
      <figure class="s13__qr">
        <div class="s13__code">${qr()}</div>
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
