/* ASHEN OATH — слайды 1, 2, 3 и 11: титул, идея, игра, клятва (сигнатурный момент). */
(function () {
  'use strict';

  // Команда: ФИО и роль, например { name: 'Имя Фамилия', role: 'код и бой' }. Пустую роль не выводим;
  // пока массив пуст, блока «Команда» на слайде 11 нет. Заполните перед выступлением — слайд соберётся сам.
  var TEAM = [];

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // Сигил из заставки игры (modules/ui.js, ICONS.sigil).
  var SIGIL =
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<circle cx="32" cy="32" r="21"/><circle cx="32" cy="32" r="16" stroke-opacity=".45"/>' +
    '<path d="M32 9v46"/><path d="M24.5 39.5 32 45l7.5-5.5"/>' +
    '<path d="M32 19.5c3.2 3 3.6 6.2 0 9.8-3.6-3.6-3.2-6.8 0-9.8z" fill="currentColor" fill-opacity=".28"/>' +
    '<path d="M11 32h6M47 32h6" stroke-opacity=".7"/></svg>';

  // Логотип как в заставке игры: ASHEN — линия с сигилом — OATH. Один и тот же на титуле и в углу слайда 2,
  // поэтому «волшебный переход» (data-morph="logo") просто уменьшает его. Линии — .spk-solid: их тоже собирают искры.
  function logo(cls, attrs) {
    return '<span class="logo ' + cls + '" lang="en" ' + attrs + '>' +
      '<span class="logo__word">ASHEN</span>' +
      '<span class="logo__rule" aria-hidden="true"><i class="logo__line spk-solid"></i><span class="logo__sigil">' + SIGIL + '</span><i class="logo__line logo__line--long spk-solid"></i></span>' +
      '<span class="logo__word">OATH</span></span>';
  }
  // Печать клятвы на слайде 11: тот же сигил, линии с pathLength="1" — прорисовываются stroke-dashoffset.
  var SEAL = SIGIL.replace(/<(circle|path)/g, '<$1 pathLength="1"');
  var PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';

  // Иконки слайда 2: 48 px, золотая линия 2 px.
  var ICON = {
    vr: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 17a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4h-8.6a3 3 0 0 1-2.8-2l-1-2.7a2.8 2.8 0 0 0-5.2 0l-1 2.7a3 3 0 0 1-2.8 2H10a4 4 0 0 1-4-4z"/><path d="M6 20.5H3v6h3M42 20.5h3v6h-3"/><path d="M14 13V9.5h20V13"/></svg>',
    gym: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M3 24h5M40 24h5M14 24h20"/><rect x="8" y="15" width="6" height="18" rx="1.5"/><rect x="34" y="15" width="6" height="18" rx="1.5"/></svg>',
    desk: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="14" width="25" height="17" rx="1.5"/><path d="M1.5 35h30l-1.5 3H3z"/><circle cx="37" cy="14" r="8"/><path d="M37 9.5V14l3 2"/></svg>'
  };

  // QR игры лежит в index.html (<template id="qr-game">, его же сверяет dev/challenge.test.mjs) — клонируем на слайд 11.
  function qr() {
    var tpl = document.getElementById('qr-game');
    if (!tpl) { console.warn('Слайд 11: нет <template id="qr-game"> в index.html'); return ''; }
    var box = document.createElement('div');
    box.appendChild(tpl.content.cloneNode(true));
    return box.innerHTML;
  }

  function team() {
    var list = TEAM.filter(function (m) { return m && m.name; });
    if (!list.length) return '';
    return '<div class="s11__team"><p class="kicker">Команда</p><ul class="s11__people">' + list.map(function (m) {
      return '<li class="s11__member"><span class="s11__name">' + esc(m.name) + '</span>' +
        (m.role ? '<span class="s11__role">' + esc(m.role) + '</span>' : '') + '</li>';
    }).join('') + '</ul></div>';
  }

  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  /* ---------- 1. Титул: логотип собирается из частиц (≤ 1,5 с), справа — живой бой с Регентом */
  Q.push({
    n: 1, sec: 20,
    html: `<section class="slide s1" data-slide="1" data-title="ASHEN OATH">
      <div class="s1__video" aria-hidden="true">
        <video data-src="media/p1/title-fight.mp4" poster="media/p1/title-poster.jpg" muted loop playsinline preload="none"></video>
        <img class="print-poster" src="media/p1/title-poster.jpg" alt="">
      </div>
      <p class="kicker">Финал ADMIT · кейс Motion</p>
      <div class="s1__body">
        <h1 class="s1__title">${logo('s1__logo', 'data-particles="1300" data-morph="logo" aria-label="ASHEN OATH"')}</h1>
        <p class="s1__tag reveal">Камера вместо джойстика</p>
        <p class="lead s1__lead reveal">Тёмное фэнтези в браузере: героем управляют руки и тело через обычную веб-камеру.</p>
        <div class="s1__actions reveal">
          <button type="button" class="btn btn--primary" data-action="autoplay" aria-pressed="false">${PLAY}<span>Смотреть</span></button>
          <a class="btn" href="ASHEN_OATH_pitch.pdf" download>PDF</a>
          <a class="btn" href="../index.html" target="_blank" rel="noopener">Играть</a>
        </div>
      </div>
      <aside class="notes">ASHEN OATH — игра, в которой контроллер — это вы. Обычный ноутбук, веб-камера, ссылка — и вы сражаетесь с боссом руками и телом. Ничего не нужно устанавливать.</aside>
    </section>`
  });

  /* ---------- 2. Идея: проблема → поворот → решение (по шагам, 25 слов) */
  Q.push({
    n: 2, sec: 30,
    html: `<section class="slide s2" data-slide="2" data-title="Игры с движением требуют железа">
      ${logo('logo--mark s2__mark', 'data-morph="logo" aria-hidden="true"')}
      <h2 class="title">Игры с движением требуют железа</h2>
      <ul class="s2__list">
        <li class="s2__item" data-step="1"><span class="s2__icon">${ICON.vr}</span><p>Приставка и&nbsp;VR&nbsp;— дорого</p></li>
        <li class="s2__item" data-step="2"><span class="s2__icon">${ICON.gym}</span><p>Фитнес-приложения бросают</p></li>
        <li class="s2__item" data-step="3"><span class="s2__icon">${ICON.desk}</span><p>Часами за&nbsp;ноутбуком</p></li>
      </ul>
      <p class="s2__turn" data-step="4">А камера уже есть в&nbsp;каждом ноутбуке</p>
      <p class="s2__solve" data-step="5"><span lang="en">ASHEN OATH</span>: камера&nbsp;— джойстик</p>
      <aside class="notes">Игры с движением упираются в железо: приставку, VR, датчики. Тренировки дома бросают. Мы часами сидим за ноутбуком. А камера уже есть в каждом ноутбуке и в каждом классе — мы сделали её джойстиком.</aside>
    </section>`
  });

  /* ---------- 3. Что это за игра: крупное видео боя и «Небесный суд», три цифры */
  Q.push({
    n: 3, sec: 40,
    html: `<section class="slide s3" data-slide="3" data-title="Бой с Регентом — руками перед камерой">
      <p class="kicker">Игра</p>
      <h2 class="title">Бой с&nbsp;Регентом — руками перед камерой</h2>
      <figure class="media s3__video">
        <video data-src="media/p1/sky-judgment.mp4" poster="media/p1/sky-judgment.jpg" muted loop playsinline preload="none"></video>
        <img class="print-poster" src="media/p1/sky-judgment.jpg" alt="">
        <figcaption class="s3__cap">Небесный суд — удар двумя руками</figcaption>
      </figure>
      <ul class="s3__stats">
        <li class="reveal"><span class="num" data-countup>5</span><span class="unit">героев</span></li>
        <li class="reveal"><span class="num" data-countup>24</span><span class="unit">жеста</span></li>
        <li class="reveal"><span class="num" data-countup>5</span><span class="unit">режимов</span></li>
      </ul>
      <aside class="notes">Это настоящая action-RPG в браузере. Босс — Регент Нимба. Левая рука ведёт героя, правая колдует, две руки вместе — «Небесный суд». Пять героев, двадцать четыре жеста, пять режимов.</aside>
    </section>`
  });

  /* ---------- 11. Клятва — финал: печать-сигил прорисовывается, из неё вылетают частицы и собирают клятву (≤ 2,5 с) */
  Q.push({
    n: 11, sec: 25,
    html: `<section class="slide s11" data-slide="11" data-title="Наша клятва">
      <div class="s11__bg" aria-hidden="true"><img src="media/p1/oath-bg.jpg" alt="" width="1920" height="1080"></div>
      <p class="kicker">Клятва</p>
      <h2 class="s11__oath" data-particles="1500" data-particles-from=".s11__seal" data-particles-delay="650">Любой ноутбук с&nbsp;камерой — игра, тренер и&nbsp;урок движения</h2>
      <div class="s11__seal" aria-hidden="true">${SEAL}</div>
      <div class="s11__main">
        <p class="s11__hands reveal">Ваши руки — это джойстик. Сыграйте сами.</p>
        <div class="s11__actions reveal">
          <a class="btn btn--primary" href="../index.html?demo&amp;present&amp;fury=100" target="_blank" rel="noopener">${PLAY}<span>Живой показ</span></a>
          <a class="btn" href="ASHEN_OATH_pitch.pdf" download>PDF</a>
        </div>
        ${team()}
      </div>
      <figure class="s11__qr">
        <div class="s11__code">${qr()}</div>
        <figcaption class="s11__url">diiaanns07-droid.github.io<br>/ADMIT_STUTU</figcaption>
      </figure>
      <p class="src s11__src">three.js · MediaPipe (Google) · three-vrm (pixiv) · PeerJS · Quaternius · KayKit · VRoid · Poly Haven · Google Fonts (OFL). Звук и мир — свои.</p>
      <aside class="notes">Наша клятва простая: любой ноутбук с камерой — это игра, тренер и урок движения. Отсканируйте QR — игра откроется в браузере. Сейчас покажем вживую. Спасибо!</aside>
    </section>`
  });
})();
