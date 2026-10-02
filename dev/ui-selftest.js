/*
 * ASHEN OATH — ui-selftest.js
 * Самопроверка ui.js в настоящем браузере (DOM, раскладка, события).
 * API_VERSION = ASHEN_V1. Не нужен в релизной сборке.
 *
 *   import { runUISelfTest } from './ui-selftest.js';
 *   const report = await runUISelfTest();   // { passed, failed, total, results, viewport }
 *
 * Тест монтирует собственный экземпляр UI поверх фальшивого canvas,
 * временно прячет другие .ao-ui на странице и всё убирает за собой.
 * Камеру, MediaPipe и Three.js тест не трогает.
 */

import { createUI as defaultCreateUI } from '../modules/ui.js';
import { FIXTURES as DEFAULT_FIXTURES } from './ui-fixtures.js';

export const API_VERSION = 'ASHEN_V1';

const clone = (o) => JSON.parse(JSON.stringify(o));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

export async function runUISelfTest({ createUI = defaultCreateUI, fixtures = DEFAULT_FIXTURES, log = null } = {}) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail: String(detail) });
    if (log) log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const F = (name, over) => {
    const v = clone(fixtures[name]);
    if (over) Object.assign(v, over);
    return v;
  };

  // Прячем чужие экземпляры UI, чтобы elementFromPoint видел только тестовый.
  const hiddenOthers = [];
  document.querySelectorAll('.ao-ui').forEach((n) => {
    hiddenOthers.push([n, n.style.visibility]);
    n.style.visibility = 'hidden';
  });

  const stage = document.createElement('div');
  stage.setAttribute('data-ao-selftest', '');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-test-canvas', '');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '0', background: '#222' });
  const root = document.createElement('div');
  stage.append(canvas, root);
  document.body.append(stage);

  const calls = [];
  const names = ['onEnableCamera', 'onCalibrate', 'onStart', 'onPause', 'onResume', 'onRestart', 'onSettings', 'onDebug', 'onExit', 'onOath', 'onTraining', 'onBuyUpgrade', 'onBack', 'onNet'];
  const callbacks = {};
  for (const n of names) {
    callbacks[n] = (arg) => {
      calls.push({ name: n, arg });
      if (n === 'onCalibrate') return Promise.resolve(true);
      return undefined;
    };
  }
  const count = (n) => calls.filter((c) => c.name === n).length;
  const last = (n) => {
    const l = calls.filter((c) => c.name === n);
    return l.length ? l[l.length - 1].arg : undefined;
  };
  const reset = () => {
    calls.length = 0;
  };

  let ui;
  try {
    ui = createUI({ root, callbacks });
  } catch (err) {
    check('createUI монтируется', false, err && err.message);
    stage.remove();
    for (const [n, v] of hiddenOthers) n.style.visibility = v;
    return summarize(results);
  }
  const layer = root.querySelector('.ao-ui');
  const $ = (sel) => layer.querySelector(sel);
  const $$ = (sel) => Array.from(layer.querySelectorAll(sel));
  const isVisible = (n) => !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const section = (name) => $(`.ao-screen--${name}`);
  const btnByText = (scope, text) => Array.from(scope.querySelectorAll('button')).find((b) => b.textContent.trim() === text && isVisible(b));
  const setRange = (input, raw) => {
    input.value = String(raw);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (k, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

  try {
    /* 1. Монтирование */
    check('createUI возвращает update/dispose', typeof ui.update === 'function' && typeof ui.dispose === 'function');
    check('apiVersion = ASHEN_V1', ui.apiVersion === 'ASHEN_V1', ui.apiVersion);
    check('корень .ao-ui создан', !!layer);
    check('контейнер ui-camera-slot создан', !!ui.cameraSlot && ui.cameraSlot.classList.contains('ui-camera-slot'));

    /* 2. Каждый экран показывает ровно свою секцию */
    for (const [name, v] of Object.entries(fixtures)) {
      ui.update(clone(v));
      const visibleScreens = $$('.ao-screen').filter(isVisible).map((s) => s.getAttribute('data-screen'));
      const hudVisible = isVisible($('.ao-hud'));
      let ok;
      if (v.screen === 'playing') ok = visibleScreens.length === 0 && hudVisible;
      else ok = visibleScreens.length === 1 && visibleScreens[0] === v.screen && hudVisible === (v.screen === 'paused');
      check(`фикстура ${name}: виден экран ${v.screen}`, ok, visibleScreens.join(',') || (hudVisible ? 'только HUD' : 'ничего'));
    }
    await frame();

    /* 3. Меню: кнопки и настройки вызывают callbacks с правильным patch */
    reset();
    ui.update(F('menu'));
    const menuSec = section('menu');
    btnByText(menuSec, 'Начать').click();
    check('меню «Начать» → onStart({from:"menu"})', count('onStart') === 1 && last('onStart').from === 'menu', JSON.stringify(last('onStart')));
    const qHigh = menuSec.querySelector('input[type=radio][value=high]');
    qHigh.click();
    check('качество «Высокое» → onSettings({quality:"high"})', JSON.stringify(last('onSettings')) === '{"quality":"high"}', JSON.stringify(last('onSettings')));
    const menuVol = menuSec.querySelector('input[type=range]');
    setRange(menuVol, 40);
    check('громкость 40% → onSettings({volume:0.4})', JSON.stringify(last('onSettings')) === '{"volume":0.4}', JSON.stringify(last('onSettings')));
    setRange(menuVol, 0);
    check('громкость 0% → volume:0 (в диапазоне 0..1)', last('onSettings').volume === 0);
    const motion = menuSec.querySelector('input[type=checkbox]');
    motion.click();
    check('уменьшенное движение → onSettings({reducedMotion:true})', JSON.stringify(last('onSettings')) === '{"reducedMotion":true}', JSON.stringify(last('onSettings')));
    const dbgToggle = menuSec.querySelector('.ao-toggle');
    dbgToggle.click();
    check('переключатель отладки → onDebug(true)', count('onDebug') === 1 && last('onDebug') === true);
    menuVol.blur();
    motion.blur();
    qHigh.blur();
    ui.update(F('menu', { settings: { quality: 'low', volume: 0.25, reducedMotion: false, sensitivity: 1 } }));
    const lowChecked = menuSec.querySelector('input[type=radio][value=low]').checked;
    check('настройки из viewModel отражаются в контролах', lowChecked && menuVol.value === '25' && menuSec.querySelector('output').textContent === '25%', `${menuVol.value}`);

    /* 4. Чувствительность 0.5..2 */
    reset();
    ui.update(F('calibration-ready'));
    const sens = section('calibration').querySelector('input[type=range]');
    setRange(sens, 150);
    const s1 = last('onSettings');
    setRange(sens, 50);
    const s2 = last('onSettings');
    setRange(sens, 200);
    const s3 = last('onSettings');
    check(
      'чувствительность → onSettings({sensitivity}) в 0.5..2',
      s1 && s1.sensitivity === 1.5 && s2.sensitivity === 0.5 && s3.sensitivity === 2 && Object.keys(s1).length === 1,
      `${JSON.stringify(s1)} ${JSON.stringify(s2)} ${JSON.stringify(s3)}`,
    );
    sens.blur();

    /* 5. Все видимые кнопки вызывают callback, недоступные — нет */
    let silent = [];
    let disabledFired = [];
    for (const [name, v] of Object.entries(fixtures)) {
      ui.update(clone(v));
      // data-ui-local — переключатель внутри UI без колбэка (режим презентации), проверяется в 22б
      const buttons = $$('button').filter((b) => isVisible(b) && !b.hasAttribute('data-ui-local'));
      for (const b of buttons) {
        ui.update(clone(v));
        if (!isVisible(b)) continue;
        const before = calls.length;
        b.click();
        const fired = calls.length > before;
        if (b.getAttribute('aria-disabled') === 'true') {
          if (fired) disabledFired.push(`${name}: ${b.textContent.trim()}`);
        } else if (!fired) silent.push(`${name}: ${b.textContent.trim()}`);
      }
    }
    check('каждая доступная видимая кнопка вызывает callback', silent.length === 0, silent.join('; '));
    check('кнопки с aria-disabled ничего не вызывают', disabledFired.length === 0, disabledFired.join('; '));

    /* 6. Слайдер не теряет фокус и значение при 240 обновлениях HP */
    reset();
    ui.update(F('paused-user'));
    const pauseVol = section('paused').querySelector('input[type=range]');
    pauseVol.focus();
    setRange(pauseVol, 30);
    let structural = 0;
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) if (n.nodeType === 1) structural += 1;
        for (const n of m.removedNodes) if (n.nodeType === 1) structural += 1;
      }
    });
    mo.observe(layer, { childList: true, subtree: true });
    for (let i = 0; i < 240; i += 1) {
      const v = F('paused-user');
      v.snapshot.player.hp = 100 - (i % 90);
      v.snapshot.boss.hp = 1000 - i * 2;
      v.snapshot.time = 40 + i / 60;
      if (i >= 120) v.settings.volume = 0.3;
      ui.update(v);
    }
    await frame();
    mo.disconnect();
    check('фокус остаётся на слайдере громкости', document.activeElement === pauseVol);
    check('значение слайдера не перезаписано устаревшими settings', pauseVol.value === '30', pauseVol.value);
    check('240 обновлений не добавили и не удалили ни одного элемента', structural === 0, `элементов: ${structural}`);
    check('onSettings вызван один раз за жест', count('onSettings') === 1, `${count('onSettings')}`);
    pauseVol.blur();
    ui.update(F('paused-user'));
    check('после blur слайдер синхронизируется с viewModel', pauseVol.value === '80', pauseVol.value);

    /* 7. Скорость update в бою (справочно, не FPS игры) */
    ui.update(F('playing'));
    const t0 = performance.now();
    const N = 600;
    for (let i = 0; i < N; i += 1) {
      const v = F('playing');
      v.snapshot.player.hp = 100 - (i % 100);
      v.snapshot.player.energy = i % 100;
      v.snapshot.boss.hp = 1000 - i;
      v.snapshot.cooldowns.dashRemaining = (i % 72) / 60;
      v.snapshot.telegraphs[0].remaining = 1.4 - (i % 84) / 60;
      ui.update(v);
    }
    const avg = (performance.now() - t0) / N;
    check('update() в бою дешёвый (среднее < 1 мс)', avg < 1, `${avg.toFixed(3)} мс на вызов`);

    /* 8. Честность статусов */
    ui.update(F('playing-lost'));
    const dockLabel = $('.ao-cvdock .ao-status__label');
    const dockTone = $('.ao-cvdock .ao-status').getAttribute('data-tone');
    check('бой при lost: «Трекинг потерян», красный тон', dockLabel.textContent === 'Трекинг потерян' && dockTone === 'bad', `${dockLabel.textContent} / ${dockTone}`);
    const goodVisible = $$('[data-tone="good"]').filter(isVisible).length;
    check('при lost нет зелёных индикаторов и слова «отлично»', goodVisible === 0 && !/отличн/i.test(layer.textContent), `зелёных: ${goodVisible}`);
    ui.update(F('camera-permission'));
    const permLabel = $('.ao-screen--camera .ao-status__label').textContent;
    ui.update(F('camera-loading'));
    const loadLabel = $('.ao-screen--camera .ao-status__label').textContent;
    check('ожидание разрешения ≠ загрузка модели', permLabel === 'Ждём разрешения браузера' && loadLabel.startsWith('Загрузка модели распознавания') && permLabel !== loadLabel, `${permLabel} | ${loadLabel}`);
    ui.update(F('camera-idle', { tracking: { status: 'ready' } }));
    const st1 = $('.ao-screen--camera .ao-status');
    check('ready без confidence → нейтральный «Трекинг активен»', st1.getAttribute('data-tone') === 'neutral' && st1.textContent.includes('Трекинг активен'), st1.textContent);
    ui.update(F('camera-idle', { tracking: { status: 'ready', confidence: 0.9 } }));
    check('ready и confidence 0.9 → зелёный', st1.getAttribute('data-tone') === 'good');
    ui.update(F('camera-idle', { tracking: { status: 'ready', confidence: 0.5 } }));
    check('ready и confidence 0.5 → жёлтый, не зелёный', st1.getAttribute('data-tone') === 'warn');
    ui.update(F('camera-idle', { tracking: { status: 'banana', confidence: 1 } }));
    check('неизвестный статус → нейтральный, не зелёный', st1.getAttribute('data-tone') === 'neutral', st1.textContent);
    ui.update(F('camera-idle', { tracking: null }));
    check('tracking=null не ломает UI', st1.textContent.includes('Камера выключена'));

    /* 9. Плашка «Демо без камеры · клавиатура» (была «DEBUG / НЕ CV») */
    for (const name of ['menu-debug', 'tutorial-debug', 'playing-debug', 'paused-debug']) {
      ui.update(F(name));
      const badge = $('.ao-debug');
      check(`${name}: видна плашка «Демо без камеры · клавиатура»`, isVisible(badge) && badge.textContent.includes('Демо без камеры'));
    }
    ui.update(F('playing'));
    check('в CV-бою надписи DEBUG нет', !isVisible($('.ao-debug')));
    ui.update(F('playing', { input: { source: 'debug', valid: true, moveX: 0 } }));
    check('input.source="debug" включает надпись даже при debug=false', isVisible($('.ao-debug')));
    ui.update(F('playing-debug'));
    check('в DEBUG CV-док говорит «Ввод: клавиатура», а не про трекинг', $('.ao-cvdock .ao-status__label').textContent === 'Ввод: клавиатура');

    /* 10. Пауза: обычная, потеря трекинга, восстановление */
    reset();
    ui.update(F('menu'));
    ui.update(F('paused-user'));
    const pauseSec = section('paused');
    const pauseH = pauseSec.querySelector('h2');
    const resumeBtn = btnByText(pauseSec, 'Продолжить бой');
    check('обычная пауза: заголовок «Пауза», продолжить можно', pauseH.textContent === 'Пауза' && resumeBtn.getAttribute('aria-disabled') !== 'true');
    ui.update(F('paused-user', { tracking: clone(fixtures['paused-lost'].tracking), pauseReason: 'user' }));
    check('потеря трекинга во время паузы → «Трекинг потерян»', pauseH.textContent === 'Трекинг потерян', pauseH.textContent);
    check('при lost «Продолжить бой» недоступна', resumeBtn.getAttribute('aria-disabled') === 'true');
    resumeBtn.click();
    check('нажатие недоступной «Продолжить бой» не возобновляет бой', count('onResume') === 0);
    ui.update(F('paused-user'));
    check('после возврата трекинга → «Трекинг восстановлен»', pauseH.textContent === 'Трекинг восстановлен', pauseH.textContent);
    check('восстановление не вызывает onResume само', count('onResume') === 0);
    btnByText(pauseSec, 'Продолжить бой').click();
    check('«Продолжить бой» после подтверждения → onResume', count('onResume') === 1);
    ui.update(F('menu'));
    ui.update(F('paused-lost'));
    check('pauseReason="tracking" → вариант lost', pauseH.textContent === 'Трекинг потерян' && pauseSec.querySelector('.ao-panel').getAttribute('data-variant') === 'lost');
    check('при потере трекинга предлагается перекалибровка', !!btnByText(pauseSec, 'Перекалибровать'));
    ui.update(F('paused-restored'));
    check('фикстура paused-restored → вариант restored', pauseSec.querySelector('.ao-panel').getAttribute('data-variant') === 'restored');
    ui.update(F('paused-user', { tracking: { status: 'ready', confidence: 0.9, calibrated: false } }));
    check('calibrated=false блокирует «Продолжить бой»', btnByText(pauseSec, 'Продолжить бой').getAttribute('aria-disabled') === 'true');

    /* 11. Обучение — тренажёр «Научись за 60 секунд»: 4 шага, «Пропустить», «В бой» только после готовности */
    reset();
    ui.update(F('tutorial-waiting'));
    const tutSec = section('tutorial');
    const tq = (sel) => tutSec.querySelector(sel);
    const cnt = () => tq('.ao-trn-count').textContent;
    check('тренажёр: шаг 1 из 4 — «Ладонь у груди», крупная кисть и превью камеры рядом',
      cnt() === '1 / 4' && tq('.ao-trn-title').textContent === 'Ладонь у груди' && !!tq('.ao-trn-pic svg.ao-pic--walk') && !!tq('.ao-trn-cam .ao-slothost'), cnt());
    check('тренажёр: «В бой» спрятана до конца шагов, «Пропустить» видна', !btnByText(tutSec, 'В бой') && !!btnByText(tutSec, 'Пропустить'));
    // подсказки «ОШИБКА»: своя — видна под кистью, чужая (про руну) — нет
    const coachBox = tq('.ao-trn-coach');
    ui.update(F('tutorial-ready', { input: { source: 'cv', valid: true, calibrated: true, tMs: 1, moveX: 0, hint: { code: 'rune_open', gesture: 'Руна', text: 'x', side: 'right' } } }));
    check('тренажёр: подсказка не своего шага не показывается', !isVisible(coachBox));
    ui.update(F('tutorial-ready', { input: { source: 'cv', valid: true, calibrated: true, tMs: 2, moveX: 0, hint: { code: 'steer_low', gesture: 'Руль', text: 'y', side: 'left' } } }));
    check('тренажёр: «ОШИБКА» своего шага — под пиктограммой, текст из gestureCoach',
      isVisible(coachBox) && !!coachBox.closest('.ao-trn-picol') && /ошибка/i.test(coachBox.textContent) && /до груди/.test(coachBox.textContent), coachBox.textContent);
    // «Пропустить» × 4 → итог
    for (let i = 0; i < 4; i++) { const b = btnByText(tutSec, 'Пропустить'); if (b) b.click(); ui.update(F('tutorial-waiting')); }
    check('тренажёр: «Пропустить» не трогает игру (только экран)', calls.length === 0, calls.map((c) => c.name).join(','));
    check('тренажёр: после 4 пропусков — итог «4 / 4», все шаги помечены пропущенными',
      cnt() === '4 / 4' && isVisible(tq('.ao-trn-done')) && tutSec.querySelectorAll('.ao-trn-pill[data-state="skip"]').length === 4, cnt());
    const fight = btnByText(tutSec, 'В бой');
    check('обучение при lost: «В бой» недоступна', !!fight && fight.getAttribute('aria-disabled') === 'true');
    fight.click();
    check('недоступная «В бой» не вызывает onStart', count('onStart') === 0);
    fight.focus();
    check('недоступная кнопка остаётся фокусируемой (aria-disabled)', document.activeElement === fight);
    ui.update(F('tutorial-ready', { tracking: { status: 'ready', confidence: 0.9, calibrated: false } }));
    check('calibrated=false блокирует «В бой»', fight.getAttribute('aria-disabled') === 'true');
    ui.update(F('tutorial-ready'));
    fight.click();
    check('обучение при ready → onStart({from:"tutorial"})', count('onStart') === 1 && last('onStart').from === 'tutorial');
    ui.update(F('tutorial-debug'));
    check('в DEBUG «В бой» доступна без камеры', fight.getAttribute('aria-disabled') !== 'true');
    btnByText(tutSec, 'Пройти ещё раз').click();
    ui.update(F('tutorial-debug'));
    check('«Пройти ещё раз» → снова шаг 1', cnt() === '1 / 4');
    check('DEBUG: на шаге подписана клавиша (W) вместо превью камеры',
      isVisible(tq('.ao-trn-keycap')) && tq('.ao-trn-keycap__key').textContent === 'W' && /держи W/.test(tq('.ao-trn-key').textContent));
    check('DEBUG: «В бой» доступна и на шаге (скрипты QA, показ без камеры)', !!btnByText(tutSec, 'В бой') && btnByText(tutSec, 'В бой').getAttribute('aria-disabled') !== 'true');
    // настоящий распознанный жест: щит (удержание ≥ 0,3 с) → «✓ Распознано!» → через 0,8 с шаг 3
    ui.update(F('menu'));
    ui.update(F('tutorial-ready'));
    btnByText(tutSec, 'Пропустить').click();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shieldIn = (t) => ({ source: 'cv', valid: true, calibrated: true, tMs: t, moveX: 0, shield: true });
    let okSeen = false;
    for (let i = 0; i < 12 && !okSeen; i++) { ui.update(F('tutorial-ready', { input: shieldIn(i) })); okSeen = isVisible(tq('.ao-trn-ok')); if (!okSeen) await sleep(60); }
    check('живой InputFrame: щит удержан → крупное «✓ Распознано!» и реакция манекена',
      okSeen && /Распознано!/.test(tq('.ao-trn-ok').textContent) && tq('.ao-trn-mq').classList.contains('is-ok') && cnt() === '2 / 4', cnt());
    await sleep(900);
    ui.update(F('tutorial-ready'));
    check('через 0,8 с — автопереход на шаг 3 «OK»', cnt() === '3 / 4' && /«OK»/.test(tq('.ao-trn-title').textContent), cnt());
    ui.update(F('tutorial-live'));
    check('живой InputFrame: «OK» правой подсвечивает шаг и манекен', tq('.ao-trn-gesture').classList.contains('is-live') && tq('.ao-trn-mq').classList.contains('is-live'));
    const tutText = tutSec.textContent.toLowerCase();
    // [№1] С HandLandmarker («Перстни») ладонь и кулак реально распознаются — их можно называть.
    // По-прежнему запрещено просить резких бросков корпусом/головой.
    check('в обучении нет «резко брось» (броски корпусом запрещены)', !/брось|бросьте|бросок/.test(tutText));
    // пройдено в этой сессии → новый вход (дуэль, «Начать», перекалибровка) — сразу итог с «В бой»
    btnByText(tutSec, 'Пропустить обучение').click();
    ui.update(F('tutorial-ready'));
    ui.update(F('menu'));
    ui.update(F('tutorial-ready'));
    check('повторный вход после прохождения — сразу итог и «В бой»', cnt() === '4 / 4' && isVisible(tq('.ao-trn-done')) && !!btnByText(tutSec, 'В бой'), cnt());
    check('на итоге превью камеры не прячется (слот не display:none)', isVisible(tq('.ao-trn-cam .ao-slothost')));
    // пройдено в отладке → камере не засчитывается
    ui.update(F('menu'));
    ui.update(F('tutorial-debug'));
    check('пройденное камерой не засчитывается отладке: в отладке — снова шаг 1', cnt() === '1 / 4', cnt());
    btnByText(tutSec, 'Пропустить обучение').click();
    ui.update(F('tutorial-debug'));
    ui.update(F('menu'));
    ui.update(F('tutorial-ready'));
    check('пройденное клавишами не засчитывается камере: с камерой — снова шаг 1', cnt() === '1 / 4', cnt());
    ui.update(F('tutorial-ready'));
    check('в обучении — не больше 120 слов на экране (было ~290)', tutSec.innerText.split(/\s+/).filter(Boolean).length <= 120, String(tutSec.innerText.split(/\s+/).filter(Boolean).length));

    /* 11б. «Книга заклинаний»: из меню и паузы; старые карточки — в разделе «Продвинутые» */
    reset();
    ui.update(F('menu'));
    const bookSec = $('.ao-screen--book');
    const bookBtnM = btnByText(section('menu'), 'Книга заклинаний');
    check('в меню есть кнопка «Книга заклинаний»', !!bookBtnM);
    bookBtnM.click();
    ui.update(F('menu'));
    check('книга открывается поверх меню, фокус на «Закрыть»', isVisible(bookSec) && document.activeElement === btnByText(bookSec, 'Закрыть'));
    check('книга модальна: меню под ней inert (Tab не уходит за книгу)', section('menu').inert === true && !bookSec.inert);
    check('книга: клавиши отладки скрыты без отладки', !bookSec.querySelector('.ao-book-card__key') || !isVisible(bookSec.querySelector('.ao-book-card__key')));
    ui.update(F('menu', { settings: { ...(fixtures.menu.settings || {}), moveMode: 'stick' } }));
    check('книга: в «Джойстике» карточка хода — текст «Джойстика»', /Ладонь вверх/.test(bookSec.querySelector('.ao-book-card .ao-h3').textContent), bookSec.querySelector('.ao-book-card .ao-h3').textContent);
    ui.update(F('menu'));
    const tabsB = bookSec.querySelectorAll('[role="tab"]');
    check('книга: вкладки «Базовые» и «Продвинутые: руны, печати, лук, магия»', tabsB.length === 2 && /Продвинутые: руны, печати, лук, магия/.test(tabsB[1].textContent));
    tabsB[1].click();
    check('книга: в «Продвинутых» все 7 прежних карточек', bookSec.querySelectorAll('.ao-book-pane:not([hidden]) .ao-tut-card').length === 7);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('Esc закрывает книгу и возвращает фокус на кнопку', !isVisible(bookSec) && document.activeElement === bookBtnM && section('menu').inert === false);
    check('книга не вызывает callback игры', calls.length === 0, calls.map((c) => c.name).join(','));
    ui.update(F('paused-user'));
    const bookBtnP = btnByText(section('paused'), 'Книга заклинаний');
    check('в паузе есть «Книга заклинаний»', !!bookBtnP);
    bookBtnP.click();
    ui.update(F('paused-user'));
    check('книга открывается поверх паузы', isVisible(bookSec));
    ui.update(F('playing'));
    check('смена экрана закрывает книгу', !isVisible(bookSec));
    ui.update(F('menu'));

    /* 12. Калибровка */
    reset();
    ui.update(F('menu'));
    ui.update(F('calibration-ready'));
    const calSec = section('calibration');
    check('до калибровки «Далее: обучение» скрыта', !btnByText(calSec, 'Далее: обучение'));
    btnByText(calSec, 'Начать калибровку').click();
    check('«Начать калибровку» → onCalibrate', count('onCalibrate') === 1);
    ui.update(F('calibration-progress'));
    check('прогресс калибровки берётся из tracking.progress', calSec.querySelector('.ao-meter--progress').getAttribute('aria-valuenow') === '55');
    ui.update(F('calibration-progress', { tracking: { status: 'ready', confidence: 0.8 } }));
    check('переход calibrating → ready засчитан как завершённая калибровка', !!btnByText(calSec, 'Далее: обучение'));
    ui.update(F('calibration-partial'));
    const body = calSec.querySelector('.ao-body');
    check('индикатор тела: не видно кистей', body.getAttribute('data-state') === 'partial' && body.textContent.includes('левая кисть'), body.textContent);
    ui.update(F('calibration-lost'));
    check('индикатор тела при lost — красный', body.getAttribute('data-state') === 'off');

    /* 13. Ошибки */
    reset();
    ui.update(F('error-model'));
    const errSec = section('error');
    check('ошибка модели: понятный заголовок', errSec.querySelector('h2').textContent === 'Не загрузилась модель распознавания');
    const raw = errSec.querySelector('.ao-errbox__raw').textContent;
    check('stack trace не показывается, деталь свернута', !/\bat\s/.test(raw) && errSec.querySelector('details').open === false, raw);
    btnByText(errSec, 'Повторить').click();
    check('ошибка модели: «Повторить» → onEnableCamera', count('onEnableCamera') === 1);
    ui.update(F('error-webgl'));
    btnByText(errSec, 'Повторить').click();
    check('ошибка WebGL: «Повторить» → onRestart', count('onRestart') === 1);
    ui.update(F('camera-error-denied'));
    check('отказ в доступе: причина и шаги на экране камеры', section('camera').querySelector('.ao-errbox__title').textContent === 'Доступ к камере запрещён');

    /* 14. HUD: способности, телеграф, стадия */
    ui.update(F('playing'));
    const tileState = (k) => $(`.ao-ab--${k}`).getAttribute('data-state');
    check('рывок на перезарядке показывает время', tileState('dash') === 'cooldown' && $('.ao-ab--dash .ao-ab__time').textContent === '0,7 с', $('.ao-ab--dash .ao-ab__time').textContent);
    check('выброс на перезарядке', tileState('burst') === 'cooldown' && $('.ao-ab--burst .ao-ab__time').textContent === '3,4 с');
    check('снаряд и щит готовы', tileState('bolt') === 'ready' && tileState('shield') === 'ready');
    check('имя босса «Регент Нимба»', $('.ao-boss__name').textContent === 'Регент Нимба');
    check('подсказка телеграфа slam', isVisible($('.ao-tele')) && $('.ao-tele__text').textContent.includes('круга'));
    ui.update(F('playing-stage2-lowhp'));
    check('nova без блока: «щит не поможет»', $('.ao-tele__text').textContent.includes('щит не поможет') && $('.ao-tele').getAttribute('data-kind') === 'nova');
    check('вторая стадия отмечена у полосы босса', isVisible($('.ao-boss__stage')));
    check('баннер второй стадии появился при переходе 1→2', isVisible($('.ao-banner')) && $('.ao-banner').textContent.includes('Вторая стадия'));
    check('щит активен при shielding', tileState('shield') === 'active');
    check('низкое HP выделено', $('.ao-hero').classList.contains('is-low'));
    ui.update(F('paused-user'));
    check('баннер скрыт вне боя', !isVisible($('.ao-banner')));
    ui.update(F('playing-debug'));
    check('удержание attack подсвечивает «Снаряд»', tileState('bolt') === 'active');

    /* 15. Итоги из stats */
    ui.update(F('victory'));
    const vText = section('victory').textContent.replace(/\s/g, '');
    check('победа: время 2:47, урон 1000, HP 46 из 100', vText.includes('2:47') && vText.includes('1000') && vText.includes('46из100'), vText.slice(0, 120));
    ui.update(F('defeat'));
    const dSec = section('defeat');
    check('поражение: у стража 42%, есть совет', dSec.textContent.includes('42%') && [...dSec.querySelectorAll('.ao-tip')].some(isVisible));
    reset();
    btnByText(dSec, 'Ещё раз').click();   // [FEEL] на поражении кнопка «Ещё раз»
    check('«Ещё раз» → onRestart', count('onRestart') === 1);

    /* 16. Escape */
    reset();
    ui.update(F('playing'));
    key('Escape');
    check('Esc в CV-бою → onPause({reason:"user", via:"keyboard"})', count('onPause') === 1 && last('onPause').reason === 'user' && last('onPause').via === 'keyboard');
    key('Escape', { repeat: true });
    check('автоповтор Esc игнорируется', count('onPause') === 1);
    ui.update(F('playing-debug'));
    key('Escape');
    check('в DEBUG Esc оставлен адаптеру сборщика', count('onPause') === 1);
    ui.update(F('menu'));
    key('Escape');
    check('Esc в меню ничего не вызывает', count('onPause') === 1);
    ui.update(F('playing'));
    btnByText($('.ao-hud'), 'Пауза').click();
    check('кнопка «Пауза» → onPause({reason:"user"})', count('onPause') === 2 && last('onPause').reason === 'user');

    /* 17. pointer-events: canvas доступен вне панелей */
    await frame();
    const W = window.innerWidth;
    const H = window.innerHeight;
    ui.update(F('playing'));
    await frame();
    const hitCenter = document.elementFromPoint(W / 2, H / 2);
    check('бой: центр экрана принадлежит canvas', hitCenter === canvas, hitCenter && hitCenter.className);
    const pb = $('.ao-pausebtn').getBoundingClientRect();
    const hitPause = document.elementFromPoint(pb.left + pb.width / 2, pb.top + pb.height / 2);
    check('бой: кнопка паузы кликабельна', !!hitPause && !!hitPause.closest('.ao-pausebtn'));
    const hero = $('.ao-hero').getBoundingClientRect();
    const hitHero = document.elementFromPoint(hero.left + 10, hero.top + 10);
    check('бой: панель героя не перехватывает указатель', hitHero === canvas);
    ui.update(F('menu'));
    await frame();
    const hitRight = document.elementFromPoint(W * 0.85, H * 0.5);
    check('меню: правая часть экрана не блокирует canvas', hitRight === canvas, hitRight && hitRight.className);
    ui.update(F('camera-idle'));
    await frame();
    const hitPanel = document.elementFromPoint(W / 2, H / 2);
    const hitCorner = document.elementFromPoint(3, 3);
    check('камера: активная панель получает указатель', !!hitPanel && !!hitPanel.closest('.ao-panel'));
    check('камера: вне панели указатель проходит к canvas', hitCorner === canvas, hitCorner && hitCorner.className);

    /* 18. Слот камеры: один элемент, переносится, не display:none */
    const slot = ui.cameraSlot;
    const vid = document.createElement('video');
    vid.muted = true;
    const ov = document.createElement('canvas');
    slot.append(vid, ov);
    const noneAncestor = (n) => {
      for (let p = n; p && p !== document.documentElement; p = p.parentElement) if (getComputedStyle(p).display === 'none') return p;
      return null;
    };
    const slotScreens = [
      ['camera-ready', true],
      ['calibration-progress', true],
      ['tutorial-ready', true],
      ['paused-lost', true],
      ['playing', true],
      ['menu', false],
      ['victory', false],
      ['error-webgl', false],
    ];
    let slotOk = true;
    const slotDetail = [];
    for (const [name, shown] of slotScreens) {
      ui.update(F(name));
      await frame();
      const r = slot.getBoundingClientRect();
      const same = root.querySelectorAll('.ui-camera-slot').length === 1 && slot.contains(vid) && slot.contains(ov);
      const bad = noneAncestor(vid);
      const sizeOk = shown ? r.width >= 100 : slot.parentElement.classList.contains('ao-slot-park');
      if (!same || bad || !sizeOk) {
        slotOk = false;
        slotDetail.push(`${name}: same=${same} none=${bad ? bad.className : '-'} w=${Math.round(r.width)}`);
      }
    }
    check('слот один, video остаётся внутри, предки никогда не display:none', slotOk, slotDetail.join('; '));
    check('у слота id="ui-camera-slot"', slot.id === 'ui-camera-slot' || !!document.getElementById('ui-camera-slot'));
    vid.remove();
    ov.remove();

    /* 19. Панели помещаются в окно без прокрутки; без backdrop-filter */
    const fitFail = [];
    let blurFound = false;
    for (const [name, v] of Object.entries(fixtures)) {
      if (v.screen === 'playing') continue;
      ui.update(clone(v));
      await frame();
      const panel = $$('.ao-screen').filter(isVisible).map((s) => s.querySelector('.ao-panel'))[0];
      if (!panel) continue;
      const r = panel.getBoundingClientRect();
      const inside = r.top >= -1 && r.left >= -1 && r.bottom <= H + 1 && r.right <= W + 1;
      const noScroll = panel.scrollHeight <= panel.clientHeight + 2;
      if (!inside || !noScroll) fitFail.push(`${name}: ${Math.round(r.height)}px, scroll ${panel.scrollHeight}/${panel.clientHeight}`);
      const bf = getComputedStyle(panel).backdropFilter || getComputedStyle(panel).webkitBackdropFilter || 'none';
      if (bf !== 'none') blurFound = true;
    }
    check(`все панели помещаются в ${W}×${H} без прокрутки`, fitFail.length === 0, fitFail.join('; '));
    check('панели без backdrop-filter', !blurFound);

    /* 20. HUD занимает малую часть арены. [ПРОЕКТОР] Превью камеры (~22 % ширины) и шпаргалка жестов
       крупные намеренно: их считаем отдельно, центр арены остаётся свободным. */
    ui.update(F('playing'));
    await frame();
    const areaOf = (sels) => sels.map((s) => $(s)).filter((n) => n && isVisible(n)).map((n) => n.getBoundingClientRect())
      .reduce((a, r) => a + r.width * r.height, 0);
    const frac = areaOf(['.ao-boss', '.ao-hero', '.ao-pausebtn']) / (W * H);
    check('HUD без превью и шпаргалки занимает меньше 15% экрана', frac < 0.15, `${(frac * 100).toFixed(1)}%`);
    const fracAll = areaOf(['.ao-boss', '.ao-hero', '.ao-pausebtn', '.ao-cvdock', '.ao-cheat']) / (W * H);
    check('HUD с превью камеры и шпаргалкой занимает меньше 36% экрана', fracAll < 0.36, `${(fracAll * 100).toFixed(1)}%`);
    const dockR = $('.ao-cvdock').getBoundingClientRect();
    check('превью камеры в бою — не меньше 20% ширины экрана (или 240 px)', dockR.width >= Math.min(0.2 * W, 240) - 1, `${Math.round(dockR.width)} px из ${W}`);
    const mid = { x: W / 2, y: H / 2 };
    const covers = ['.ao-cvdock', '.ao-cheat', '.ao-hero'].some((s) => { const r = $(s).getBoundingClientRect(); return mid.x >= r.left && mid.x <= r.right && mid.y >= r.top && mid.y <= r.bottom; });
    check('центр арены свободен от HUD', !covers);

    /* 21. Уменьшенное движение */
    ui.update(F('menu', { settings: { quality: 'medium', volume: 0.8, reducedMotion: true, sensitivity: 1 } }));
    await frame();
    check('reducedMotion выключает анимации', layer.classList.contains('ao-reduced-motion') && getComputedStyle(section('menu')).animationName === 'none');

    /* 22. Фокус при смене экрана */
    ui.update(F('menu'));
    ui.update(F('camera-idle'));
    await frame();
    check('на экране камеры фокус на «Разрешить камеру»', document.activeElement && document.activeElement.textContent.trim() === 'Разрешить камеру', document.activeElement && document.activeElement.textContent.trim());

    /* 22б. [ПРОЕКТОР] подписи жестов под превью, «ОШИБКА», шпаргалка (Tab), режим презентации (P) */
    {
      let cheatSaved = null;
      try { cheatSaved = localStorage.getItem('ashen-oath.cheat.v1'); localStorage.removeItem('ashen-oath.cheat.v1'); } catch (e) { /* нет хранилища */ }
      const liveIn = (extra) => ({
        source: 'cv', valid: true, calibrated: true, moveX: 0, dash: 0, attack: false, shield: false, burst: false,
        hands: { available: true, left: { shape: 'open', palmFacing: 'camera', charge: 0 }, right: { shape: 'pinch', palmFacing: 'camera', charge: 0 } },
        ...extra,
      });
      const rows = () => [...layer.querySelectorAll('.ao-cvdock .ao-gread__row')].map((n) => n.textContent);
      ui.update(F('playing', { input: liveIn({ attack: true, shield: true }) }));
      await frame();
      check('под превью: «ЛЕВАЯ: ЩИТ» и «ПРАВАЯ: OK → ВЫСТРЕЛ»', rows()[0] === 'ЛЕВАЯ: ЩИТ' && rows()[1] === 'ПРАВАЯ: OK → ВЫСТРЕЛ', rows().join(' | '));
      const hint = { code: 'ok_ring_open', gesture: '«OK» · снаряд', text: 'Сомкни кончики большого и указательного в кольцо', side: 'right', tMs: 77 };
      ui.update(F('playing', { input: liveIn({ burst: true, hint }) }));
      await frame();
      ui.update(F('playing', { input: liveIn({}) }));
      await frame();
      check('импульс «ВЫБРОС!» держится после своего кадра', rows()[1] === 'ПРАВАЯ: ВЫБРОС!', rows()[1]);
      const errNode = $('.ao-cvdock .ao-gread__err');
      check('«ОШИБКА»: красная рамка превью и текст подсказки', $('.ao-cvdock').getAttribute('data-err') === 'on' && isVisible(errNode) && /Сомкни кончики/.test(errNode.textContent), errNode && errNode.textContent);
      const item = (k) => $(`.ao-cheat__item[data-key="${k}"]`);
      check('шпаргалка: 6 жестов, сработавший «Выброс» подсвечен', layer.querySelectorAll('.ao-cheat__item').length === 6 && item('burst').getAttribute('data-state') === 'active', item('burst') && item('burst').getAttribute('data-state'));
      check('шпаргалка: «Рывок» на перезарядке тускнеет', item('dash').getAttribute('data-state') === 'cooldown' && getComputedStyle(item('dash')).opacity < 0.7);
      const small = [...layer.querySelectorAll('.ao-cheat *, .ao-cvdock .ao-gread *')].filter((n) => isVisible(n) && n.childNodes.length && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(n).fontSize) < 14);
      check('шпаргалка и подписи — шрифт не меньше 14 px', small.length === 0, small.map((n) => `${n.className}:${getComputedStyle(n).fontSize}`).join(', '));
      key('Tab', { code: 'Tab' });
      ui.update(F('playing'));
      await frame();
      check('Tab в бою скрывает шпаргалку, остаётся подсказка «Tab»', !isVisible($('.ao-cheat')) && isVisible($('.ao-cheat-pill')));
      key('Tab', { code: 'Tab' });
      ui.update(F('playing'));
      await frame();
      check('повторный Tab возвращает шпаргалку', isVisible($('.ao-cheat')));
      key('p', { code: 'KeyP' });
      ui.update(F('playing'));
      await frame();
      const pslot = ui.cameraSlot;
      check('P: режим презентации, слот камеры в левой панели 40 %', document.documentElement.classList.contains('ao-present') && pslot.parentElement.classList.contains('ao-pres__cam') && isVisible($('.ao-pres')) && Math.abs($('.ao-pres').getBoundingClientRect().width - 0.4 * W) < 3);
      const htmlCs = getComputedStyle(document.documentElement);
      check('в режиме презентации <html> не получает стилей панели (не fixed, указатель работает)', htmlCs.position !== 'fixed' && htmlCs.pointerEvents !== 'none', `${htmlCs.position}/${htmlCs.pointerEvents}`);
      // в 60 % ширины длинные экраны могут прокручиваться, но главная кнопка обязана быть видна сразу
      const presFail = [];
      for (const [name, label] of [['menu', 'Начать'], ['tutorial-live', 'В бой'], ['paused-lost', 'Продолжить бой']]) {
        if (!fixtures[name]) continue;
        ui.update(F(name));
        await frame();
        const pnl = $$('.ao-screen').filter(isVisible).map((sc) => sc.querySelector('.ao-panel'))[0];
        const b = pnl && btnByText(pnl, label);
        const r = b && b.getBoundingClientRect(), pr = pnl && pnl.getBoundingClientRect();
        if (!r || r.top < pr.top - 1 || r.bottom > Math.min(pr.bottom, H) + 1 || r.left < 0.4 * W - 1) presFail.push(`${name}: «${label}» ${r ? Math.round(r.top) + '..' + Math.round(r.bottom) : 'нет'}`);
      }
      check(`режим презентации: главная кнопка видна без прокрутки (меню, обучение, пауза) в ${W}×${H}`, presFail.length === 0, presFail.join('; '));
      ui.update(F('playing'));
      await frame();
      key('p', { code: 'KeyP' });
      ui.update(F('playing'));
      await frame();
      check('повторный P выключает режим, слот снова в доке', !document.documentElement.classList.contains('ao-present') && pslot.parentElement.classList.contains('ao-cvdock__slot'));
      ui.update(F('menu'));
      await frame();
      const pbtn = $('.ao-toggle--present');
      pbtn.click();
      ui.update(F('menu'));
      const onByClick = document.documentElement.classList.contains('ao-present') && pbtn.getAttribute('aria-pressed') === 'true';
      pbtn.click();
      ui.update(F('menu'));
      check('кнопка «Режим презентации · P» в меню включает и выключает режим', onByClick && !document.documentElement.classList.contains('ao-present'));
      ui.update(F('playing-debug'));
      await frame();
      key('p', { code: 'KeyP' });
      check('в бою с отладкой P остаётся «призмой» (режим не переключается)', !document.documentElement.classList.contains('ao-present'));
      key('P', { code: 'KeyP', shiftKey: true });
      ui.update(F('playing-debug'));
      const shiftOn = document.documentElement.classList.contains('ao-present');
      key('P', { code: 'KeyP', shiftKey: true });
      ui.update(F('playing-debug'));
      check('в бою с отладкой режим переключает Shift+P', shiftOn && !document.documentElement.classList.contains('ao-present'));
      try { if (cheatSaved === null) localStorage.removeItem('ashen-oath.cheat.v1'); else localStorage.setItem('ashen-oath.cheat.v1', cheatSaved); } catch (e) { /* нет хранилища */ }
    }

    /* 23. dispose */
    reset();
    ui.update(F('playing'));
    const pauseNode = $('.ao-pausebtn');
    ui.dispose();
    key('Escape');
    pauseNode.click();
    let threw = false;
    try {
      ui.update(F('menu'));
    } catch (e) {
      threw = true;
    }
    check('dispose: DOM удалён', !root.querySelector('.ao-ui'));
    check('dispose: обработчики сняты (Esc и клик ничего не вызывают)', calls.length === 0, JSON.stringify(calls));
    check('update после dispose безопасен', !threw);
    ui.dispose();
    check('повторный dispose безопасен', true);
  } catch (err) {
    check('самопроверка завершилась без исключений', false, `${err && err.message}\n${err && err.stack}`);
    try {
      ui.dispose();
    } catch (e) {
      /* уже удалён */
    }
  } finally {
    stage.remove();
    for (const [n, v] of hiddenOthers) n.style.visibility = v;
  }
  return summarize(results);
}

function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  return {
    apiVersion: API_VERSION,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed,
    results,
  };
}
