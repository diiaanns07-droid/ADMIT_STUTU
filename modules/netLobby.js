// ASHEN OATH — экран «Онлайн-дуэль» (№2 [NET]). Только вид: вся логика в net/session.js.
// createNetLobby({ root, actions }) → { render(view), show(on), dispose() }
//   actions: host(mode, lanHost), join(mode, code, lanHost), ready(on), leave(), close(), mode(m), profile(patch)
// Оформление — в духе BDO: тёмная полупрозрачная панель, тонкая золотая кайма, антиква (netLobby.css).

const STATUS_TEXT = { idle: 'Не подключено', connecting: 'Подключение…', connected: 'Соперник на связи', lost: 'Связь потеряна' };

export function ensureLobbyCss() { loadCss(); }

function loadCss() {
  if (document.getElementById('nl-css')) return;
  const l = document.createElement('link');
  l.id = 'nl-css'; l.rel = 'stylesheet';
  l.href = new URL('./netLobby.css', import.meta.url).href;
  document.head.appendChild(l);
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c) n.append(c);
  return n;
}

export function createNetLobby({ root, actions }) {
  loadCss();
  const A = actions || {};
  let V = null;
  let lastRenderedCode = null;

  const nameIn = el('input', { class: 'nl-input', type: 'text', maxlength: '16', placeholder: 'Ваше имя', autocomplete: 'nickname', spellcheck: 'false', 'aria-label': 'Имя игрока' });
  nameIn.addEventListener('change', () => A.profile && A.profile({ netName: nameIn.value.trim().slice(0, 16) }));
  const heroBox = el('div', { class: 'nl-heroes', role: 'radiogroup', 'aria-label': 'Герой' });
  const modeBtns = {
    peer: el('button', { type: 'button', class: 'nl-seg', 'data-mode': 'peer', text: 'Интернет' }),
    lan: el('button', { type: 'button', class: 'nl-seg', 'data-mode': 'lan', text: 'LAN' }),
    local: el('button', { type: 'button', class: 'nl-seg', 'data-mode': 'local', text: 'Две вкладки' }),
  };
  for (const [m, b] of Object.entries(modeBtns)) b.addEventListener('click', () => A.mode && A.mode(m));
  const lanIn = el('input', { class: 'nl-input nl-input--mono', type: 'text', inputmode: 'decimal', placeholder: '192.168.1.23', spellcheck: 'false', 'aria-label': 'IP ноутбука-хоста' });
  const lanHint = el('p', { class: 'nl-hint' });
  const lanBox = el('div', { class: 'nl-lan' }, el('label', { class: 'nl-label', text: 'IP ноутбука, где запущен ретранслятор' }), lanIn, lanHint);
  const modeHint = el('p', { class: 'nl-hint nl-modehint' });

  const hostBtn = el('button', { type: 'button', class: 'nl-btn nl-btn--primary', text: 'Создать комнату' });
  hostBtn.addEventListener('click', () => A.host && A.host(V.mode, lanIn.value));
  const codeIn = el('input', { class: 'nl-input nl-input--code', type: 'text', maxlength: '5', placeholder: 'КОД', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Код комнаты' });
  codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  const joinBtn = el('button', { type: 'button', class: 'nl-btn', text: 'Войти по коду' });
  const doJoin = () => A.join && A.join(V.mode, codeIn.value, lanIn.value);
  joinBtn.addEventListener('click', doJoin);
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  const actionsBox = el('div', { class: 'nl-actions' },
    hostBtn,
    el('div', { class: 'nl-or' }, el('span', { text: 'или' })),
    el('div', { class: 'nl-joinrow' }, codeIn, joinBtn));

  const codeBig = el('div', { class: 'nl-code', 'aria-live': 'polite' });
  const copyBtn = el('button', { type: 'button', class: 'nl-btn nl-btn--small', text: 'Копировать' });
  copyBtn.addEventListener('click', async () => {
    const code = V && V.code;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = 'Скопировано'; }
    catch (e) { const r = document.createRange(); r.selectNodeContents(codeBig); const s = getSelection(); s.removeAllRanges(); s.addRange(r); copyBtn.textContent = 'Выделено — Ctrl+C'; }
    setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1600);
  });
  const meCard = el('div', { class: 'nl-card nl-card--me' });
  const oppCard = el('div', { class: 'nl-card nl-card--opp' });
  const readyBtn = el('button', { type: 'button', class: 'nl-btn nl-btn--primary nl-btn--ready', text: 'Готов' });
  readyBtn.addEventListener('click', () => A.ready && A.ready(!(V && V.meReady)));
  const leaveBtn = el('button', { type: 'button', class: 'nl-btn nl-btn--quiet', text: 'Выйти из комнаты' });
  leaveBtn.addEventListener('click', () => A.leave && A.leave());
  const countdown = el('div', { class: 'nl-countdown', 'aria-live': 'assertive' });
  const roomBox = el('div', { class: 'nl-room' },
    el('div', { class: 'nl-code-label', text: 'Код комнаты' }),
    el('div', { class: 'nl-coderow' }, codeBig, copyBtn),
    el('div', { class: 'nl-vs' }, meCard, el('div', { class: 'nl-vs__sep', text: 'VS' }), oppCard),
    countdown,
    el('div', { class: 'nl-roomrow' }, readyBtn, leaveBtn));

  const dot = el('span', { class: 'nl-dot' });
  const statusText = el('span', { class: 'nl-status__text' });
  const pingText = el('span', { class: 'nl-ping' });
  const msg = el('p', { class: 'nl-msg' });
  const status = el('div', { class: 'nl-status', role: 'status' }, dot, statusText, pingText);
  const errText = el('p', { class: 'nl-error__text' });
  const toLanBtn = el('button', { type: 'button', class: 'nl-btn nl-btn--small', text: 'Переключиться на LAN' });
  toLanBtn.addEventListener('click', () => A.mode && A.mode('lan'));
  const errBox = el('div', { class: 'nl-error', role: 'alert' }, errText, toLanBtn);

  const closeBtn = el('button', { type: 'button', class: 'nl-close', 'aria-label': 'Закрыть', text: '×' });
  closeBtn.addEventListener('click', () => A.close && A.close());

  const panel = el('section', { class: 'nl-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'nl-title' },
    el('header', { class: 'nl-head' },
      el('div', { class: 'nl-head__orn', 'aria-hidden': 'true' }),
      el('h2', { class: 'nl-title', id: 'nl-title', text: 'Онлайн-дуэль' }),
      el('p', { class: 'nl-sub', text: 'Два героя, два ноутбука, одна арена' }),
      closeBtn),
    el('div', { class: 'nl-grid' },
      el('div', { class: 'nl-col' },
        el('label', { class: 'nl-label', text: 'Имя' }), nameIn,
        el('div', { class: 'nl-label', text: 'Герой' }), heroBox,
        el('div', { class: 'nl-label', text: 'Связь' }),
        el('div', { class: 'nl-segs', role: 'group', 'aria-label': 'Режим связи' }, modeBtns.peer, modeBtns.lan, modeBtns.local),
        modeHint, lanBox),
      el('div', { class: 'nl-col nl-col--room' }, actionsBox, roomBox, status, msg, errBox)));
  const overlay = el('div', { class: 'nl-overlay', hidden: true }, panel);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); A.close && A.close(); } });
  (root || document.body).appendChild(overlay);

  const MODE_HINT = {
    peer: 'Через интернет по коду комнаты (PeerJS). Подходит для GitHub Pages. Если соединение не проходит — раздайте интернет с телефона или включите LAN.',
    lan: 'Одна Wi-Fi-сеть (или раздача с телефона). На ноутбуке-хосте запустите START_ONLINE_HOST.cmd — он покажет IP. Оба открывают игру у себя через «python serve_game.py».',
    local: 'Две вкладки или окна одного браузера на этом ноутбуке — для проверки.',
  };

  function card(node, { title, name, hero, ready, empty }) {
    node.replaceChildren(
      el('div', { class: 'nl-card__title', text: title }),
      el('div', { class: 'nl-card__name', text: empty ? '—' : name }),
      el('div', { class: 'nl-card__hero', text: empty ? 'ждём соперника…' : hero }),
      el('div', { class: `nl-card__ready${ready ? ' is-on' : ''}`, text: empty ? '' : ready ? 'Готов' : 'Не готов' }));
  }

  function render(v) {
    V = v;
    if (document.activeElement !== nameIn && nameIn.value !== v.name) nameIn.value = v.name;
    if (document.activeElement !== lanIn && lanIn.value !== v.lanHost) lanIn.value = v.lanHost || '';
    // герои
    if (heroBox.childElementCount !== v.heroes.length) {
      heroBox.replaceChildren(...v.heroes.map((h) => {
        const b = el('button', { type: 'button', class: 'nl-hero', role: 'radio', 'data-hero': h.id, text: h.name });
        b.addEventListener('click', () => A.profile && A.profile({ hero: h.id }));
        return b;
      }));
    }
    for (const b of heroBox.children) {
      const on = b.getAttribute('data-hero') === v.hero;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    const inRoom = v.status !== 'idle' || !!v.code;
    // режим
    for (const [m, b] of Object.entries(modeBtns)) {
      b.classList.toggle('is-on', v.mode === m);
      b.setAttribute('aria-pressed', v.mode === m ? 'true' : 'false');
      b.disabled = inRoom;
    }
    modeBtns.local.hidden = !v.showLocal;
    modeHint.textContent = MODE_HINT[v.mode] || '';
    lanBox.hidden = v.mode !== 'lan';
    lanIn.disabled = inRoom;
    lanHint.textContent = v.https
      ? 'Эта страница открыта по https — браузер заблокирует ws:// (mixed content). Для LAN откройте игру у себя через «python serve_game.py» (http://127.0.0.1:8765).'
      : 'Пусто — ретранслятор на этом же ноутбуке (127.0.0.1). Порт 8790.';
    lanHint.classList.toggle('is-warn', !!v.https);
    // до комнаты — кнопки, в комнате — код и готовность
    actionsBox.hidden = inRoom;
    hostBtn.disabled = v.busy; joinBtn.disabled = v.busy; codeIn.disabled = v.busy;
    roomBox.hidden = !inRoom;
    if (v.code !== lastRenderedCode) { codeBig.textContent = v.code || '····'; lastRenderedCode = v.code; }
    copyBtn.hidden = !(v.isHost && v.code);
    card(meCard, { title: v.isHost ? 'Вы · хост' : 'Вы', name: v.name, hero: (v.heroes.find((h) => h.id === v.hero) || {}).name || v.hero, ready: v.meReady });
    card(oppCard, { title: 'Соперник', name: v.opponent && v.opponent.name, hero: v.opponent && v.opponent.heroName, ready: v.oppReady, empty: !v.opponent || v.status === 'idle' });
    readyBtn.disabled = v.status !== 'connected' || v.started;
    readyBtn.textContent = v.meReady ? 'Не готов' : 'Готов';
    readyBtn.classList.toggle('is-on', v.meReady);
    countdown.textContent = v.startIn > 0 ? `Бой через ${Math.ceil(v.startIn / 1000)}…` : v.meReady && !v.oppReady ? 'Ждём готовности соперника' : '';
    // статус
    overlay.setAttribute('data-status', v.status);
    statusText.textContent = v.busy ? 'Подключение…' : v.isHost && v.status === 'connecting' ? 'Комната открыта — ждём соперника' : STATUS_TEXT[v.status] || v.status;
    pingText.textContent = v.status === 'connected' && v.ping > 0 ? `пинг ${v.ping} мс` : '';
    pingText.classList.toggle('is-bad', v.ping > 180);
    msg.textContent = v.message || '';
    errBox.hidden = !v.error;
    errText.textContent = v.error || '';
    toLanBtn.hidden = !(v.error && v.mode === 'peer' && !inRoom);
  }

  function show(on) {
    overlay.hidden = !on;
    if (on) setTimeout(() => { try { (V && V.code ? readyBtn : nameIn.value ? hostBtn : nameIn).focus(); } catch (e) { /* ignore */ } }, 30);
  }

  return { render, show, dispose() { overlay.remove(); }, get node() { return overlay; } };
}
