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
  const names = ['onEnableCamera', 'onCalibrate', 'onStart', 'onPause', 'onResume', 'onRestart', 'onSettings', 'onDebug', 'onExit', 'onOath', 'onTraining', 'onBuyUpgrade', 'onBack'];
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
      const buttons = $$('button').filter(isVisible);
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

    /* 9. DEBUG / НЕ CV */
    for (const name of ['menu-debug', 'tutorial-debug', 'playing-debug', 'paused-debug']) {
      ui.update(F(name));
      const badge = $('.ao-debug');
      check(`${name}: видна надпись DEBUG / НЕ CV`, isVisible(badge) && badge.textContent.includes('DEBUG / НЕ CV'));
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

    /* 11. Обучение: «В бой» только после готовности */
    reset();
    ui.update(F('tutorial-waiting'));
    const tutSec = section('tutorial');
    const fight = btnByText(tutSec, 'В бой');
    check('обучение при lost: «В бой» недоступна', fight.getAttribute('aria-disabled') === 'true');
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
    ui.update(F('menu'));
    ui.update(F('tutorial-live'));
    const chip = (k) => tutSec.querySelector(`[data-key="${k}"] .ao-chip`);
    check('живой InputFrame: наклон вправо отмечен частично', chip('strafe').getAttribute('data-state') === 'partial', chip('strafe').textContent);
    check('живой InputFrame: правая рука отмечена, левая ещё нет', chip('hands').getAttribute('data-state') === 'partial' && tutSec.querySelector('[data-key="hands"]').classList.contains('is-attack'));
    check('рывок и выброс без события не отмечены', chip('dash').getAttribute('data-state') === 'try' && chip('both').getAttribute('data-state') === 'try');
    const tutText = tutSec.textContent.toLowerCase();
    // [№1] С HandLandmarker («Перстни») ладонь и кулак реально распознаются — их можно называть.
    // По-прежнему запрещено просить резких бросков корпусом/головой.
    check('в обучении нет «резко брось» (броски корпусом запрещены)', !/брось|бросьте|бросок/.test(tutText));

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
    check('поражение: у стража 42%, есть совет', dSec.textContent.includes('42%') && isVisible(dSec.querySelector('.ao-tip')));
    reset();
    btnByText(dSec, 'Сразиться снова').click();
    check('«Сразиться снова» → onRestart', count('onRestart') === 1);

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

    /* 20. HUD занимает малую часть арены */
    ui.update(F('playing'));
    await frame();
    const area = ['.ao-boss', '.ao-hero', '.ao-cvdock', '.ao-pausebtn']
      .map((s) => $(s).getBoundingClientRect())
      .reduce((a, r) => a + r.width * r.height, 0);
    const frac = area / (W * H);
    check('HUD занимает меньше 15% экрана', frac < 0.15, `${(frac * 100).toFixed(1)}%`);

    /* 21. Уменьшенное движение */
    ui.update(F('menu', { settings: { quality: 'medium', volume: 0.8, reducedMotion: true, sensitivity: 1 } }));
    await frame();
    check('reducedMotion выключает анимации', layer.classList.contains('ao-reduced-motion') && getComputedStyle(section('menu')).animationName === 'none');

    /* 22. Фокус при смене экрана */
    ui.update(F('menu'));
    ui.update(F('camera-idle'));
    await frame();
    check('на экране камеры фокус на «Разрешить камеру»', document.activeElement && document.activeElement.textContent.trim() === 'Разрешить камеру', document.activeElement && document.activeElement.textContent.trim());

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
