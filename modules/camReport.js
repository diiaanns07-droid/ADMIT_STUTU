// ASHEN OATH — modules/camReport.js [W5-КАМЕРА]. Экран камеры: «что делать» и «Диагностика».
//
// Тексты для игрока по коду ошибки vision.js (mapCameraError, fail) и по состоянию запуска распознавания,
// строки «Диагностики» и текст «Скопировать отчёт» — его владелец игры присылает нам, когда «игра не видит камеру».
// Чистые функции без DOM: ui.js рисует, тесты — dev/camReport.test.mjs.
//
//  cameraAdvice(code, message, { embedded }) → null | { kind, retry, title, reason, steps[] }   — ошибка камеры
//  startupHint(tr, { sinceMs, embedded })     → null | { tone, text, steps[] }                  — пока не ошибка
//  diagRows(tracking, diag)                   → [[название, значение], …]
//  reportText(tracking, diag, { now })        → строка отчёта

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => (num(v) ? String(Math.round(v * 10) / 10).replace('.', ',') : '—');
const STEP_RU = { 'worker-gpu': 'воркер · видеокарта', 'worker-cpu': 'воркер · процессор', 'main-gpu': 'основной поток · видеокарта', 'main-cpu': 'основной поток · процессор' };
export const stepName = (s) => STEP_RU[s] || (s ? String(s) : '—');
const RETRY = 'Нажмите «Повторить».';

// Ошибка камеры по коду vision.js. retry: 'camera' — кнопка «Повторить» включает камеру снова, 'reload' — обновить страницу.
export function cameraAdvice(code, message = '', o = {}) {
  const embedded = !!o.embedded;
  switch (code) {
    case 'embedded-blocked':
      return { kind: 'iframe', retry: 'camera', title: 'Камеру блокирует встроенное окно',
        reason: 'Игра открыта во встроенном превью (например, VS Code), а оно не даёт сайту камеру.',
        steps: ['Откройте игру в отдельной вкладке Chrome или Edge: http://127.0.0.1:8765/ (START_GAME.cmd) или адрес GitHub Pages.', 'В новой вкладке разрешите камеру.'] };
    case 'permission-denied':
      if (embedded) return cameraAdvice('embedded-blocked', message, o);
      return { kind: 'denied', retry: 'camera', title: 'Доступ к камере запрещён',
        reason: 'Браузер или система не дали игре доступ к веб-камере.',
        steps: ['Нажмите значок камеры или замка слева от адреса и выберите «Разрешить».', 'Windows: Параметры → Конфиденциальность → Камера — разрешите доступ браузеру.', RETRY] };
    case 'device-busy':
      return { kind: 'busy', retry: 'camera', title: 'Камера занята',
        reason: 'Камеру держит другая программа или вкладка (видеозвонок, OBS, вторая вкладка с игрой).',
        steps: ['Закройте Zoom, Teams, Discord, OBS и другие вкладки с камерой.', 'Если не помогло — выньте и снова вставьте USB-камеру.', RETRY] };
    case 'no-device':
      return { kind: 'nocamera', retry: 'camera', title: 'Камера не найдена',
        reason: 'Браузер не видит ни одной веб-камеры.',
        steps: ['Подключите камеру; на ноутбуке проверьте шторку и клавишу камеры (Fn).', RETRY] };
    case 'device-lost':
      return { kind: 'lost', retry: 'camera', title: 'Камера отключилась',
        reason: 'Камера пропала во время игры: кабель, USB-разъём или её забрала другая программа.',
        steps: ['Проверьте кабель камеры.', RETRY] };
    case 'video-failed':
      return { kind: 'video', retry: 'camera', title: 'Видео с камеры не пошло',
        reason: 'Камера включилась, но не присылает кадры.',
        steps: ['Закройте другие программы с камерой и выньте-вставьте камеру.', RETRY] };
    case 'insecure-context':
      return { kind: 'secure', retry: 'camera', title: 'Нужен защищённый адрес',
        reason: 'Браузер даёт камеру только страницам https:// или http://localhost.',
        steps: ['Запустите START_GAME.cmd и откройте http://127.0.0.1:8765/ или адрес GitHub Pages (https).', 'Открытие файла двойным кликом и адрес по IP в сети для камеры не подходят.'] };
    case 'unsupported':
      return { kind: 'unsupported', retry: 'camera', title: 'Браузер не даёт камеру',
        reason: 'Этот браузер или это окно не умеет давать сайту веб-камеру.',
        steps: ['Откройте игру в свежем Chrome или Edge через localhost или https.'] };
    case 'model-failed':
      if (/загрузить модель/i.test(message)) {
        return { kind: 'model', retry: 'reload', title: 'Не загрузилась модель распознавания',
          reason: 'Библиотека MediaPipe или модель позы не получены (при первом запуске это ~25 МБ).',
          steps: ['Проверьте интернет или запустите игру локально (START_GAME.cmd — работает без сети).', 'Обновите страницу.'] };
      }
      return { kind: 'model-run', retry: 'reload', title: 'Распознавание остановилось',
        reason: 'Распознавание позы не смогло работать ни на видеокарте, ни на процессоре.',
        steps: ['Закройте тяжёлые вкладки и программы, подключите ноутбук к зарядке.', 'Обновите страницу.', 'Если повторяется — раскройте «Диагностику» и нажмите «Скопировать отчёт».'] };
    case 'camera-failed':
      return { kind: 'camera', retry: 'camera', title: 'Камера не включилась',
        reason: message || 'Браузер не смог включить камеру.',
        steps: ['Закройте другие программы с камерой.', RETRY] };
    default:
      return null;
  }
}

// «Что делать», пока ошибки нет, но игра ещё не видит игрока (или распознавание не успевает).
// tr — нормализованный статус (status, message), sinceMs — сколько длится текущий статус.
export function startupHint(tr, o = {}) {
  if (!tr) return null;
  const since = num(o.sinceMs) ? o.sinceMs : 0;
  const msg = String(tr.message || '');
  if (tr.status === 'permission' && since > 6000) {
    return { tone: 'warn', text: 'Браузер ждёт разрешения на камеру', steps: o.embedded
      ? ['Во встроенном превью камера не работает — откройте игру в Chrome или Edge.']
      : ['Запрос — у адресной строки: нажмите значок камеры и выберите «Разрешить».'] };
  }
  if (tr.status === 'loading' && /Видеокарта не успевает|Фоновый поток не справился|на процессор/.test(msg)) {
    return { tone: 'warn', text: 'Видеокарта занята — распознавание перезапускается', steps: ['Ничего нажимать не нужно: игра сама выберет, где считать распознавание.', 'Закройте вкладки с видео и игры — так быстрее.'] };
  }
  if (tr.status === 'loading' && /^Загрузка распознавания/.test(msg) && since > 15000) {
    return { tone: 'warn', text: 'Медленная сеть: распознавание ещё качается', steps: ['Первый запуск качает ~25 МБ, дальше игра работает без сети.', 'Быстрее: запустить игру локально — START_GAME.cmd.'] };
  }
  if (tr.status === 'loading' && since > 20000) {
    return { tone: 'warn', text: 'Распознавание запускается дольше обычного', steps: ['Закройте тяжёлые вкладки и программы, подключите ноутбук к зарядке.', 'Если так больше минуты — раскройте «Диагностику» и нажмите «Скопировать отчёт».'] };
  }
  if (tr.status === 'lost' && /Нет новых кадров/.test(msg)) {
    return { tone: 'bad', text: 'Камера не присылает кадры', steps: ['Откройте шторку камеры; закройте программы, которые её используют.', 'Выньте и снова вставьте USB-камеру.'] };
  }
  if (tr.status === 'lost' && /не успевает/.test(msg)) {
    return { tone: 'warn', text: 'Распознавание не успевает за камерой', steps: ['Игра уже снижает графику, чтобы освободить видеокарту.', 'Закройте вкладки с видео и игры.'] };
  }
  return null;
}

// Строки «Диагностики»: tracking — сырой статус vision.getStatus(), diag — от main.js (кадры игры, видеокарта, …).
export function diagRows(tracking, diag) {
  const t = tracking && typeof tracking === 'object' ? tracking : {};
  const d = t.debug && typeof t.debug === 'object' ? t.debug : {};
  const g = diag && typeof diag === 'object' ? diag : {};
  const p = g.perf && typeof g.perf === 'object' ? g.perf : {};
  const rows = [];
  const video = d.video && d.video.w ? `${d.video.w}×${d.video.h}` : '—';
  // частота по кадрам, дошедшим до распознавания; нет её (основной поток не успевает) — по счётчику кадров плеера
  const vf = d.camera && num(d.camera.videoFps) ? d.camera.videoFps : null;
  const camFps = num(d.cameraFps) ? `${r1(d.cameraFps)} к/с` : vf !== null ? `${r1(vf)} к/с (плеер)` : '— к/с';
  rows.push(['Камера', `${camFps} · кадр ${video}${d.cameraFallback ? ` · ${d.cameraFallback}` : ''}`]);
  rows.push(['Распознаваний', `${num(d.inferenceHz) ? r1(d.inferenceHz) : '—'} в секунду · поза ${num(d.inferMs) ? `${r1(d.inferMs)} мс` : '—'} · задержка ${num(d.latencyMs) ? `${r1(d.latencyMs)} мс` : '—'}`]);
  const where = t.mode === 'worker' ? 'воркер (фоновый поток)' : t.mode === 'main' ? 'основной поток' : '—';
  const dev = t.delegate === 'GPU' ? 'видеокарта (GPU)' : t.delegate === 'CPU' ? 'процессор (CPU)' : '—';
  rows.push(['Где считается', `${where} · ${dev}`]);
  if (Array.isArray(d.ladder) && d.ladder.length) {
    const i = d.ladder.indexOf(d.engineStep);
    rows.push(['Ступень отката', `${i >= 0 ? `${i + 1} из ${d.ladder.length}` : '—'}${d.ladderSwitching ? ' · переход…' : ''}`]);
  }
  if (Array.isArray(d.ladderHistory) && d.ladderHistory.length) rows.push(['Откаты', d.ladderHistory.map((h) => `${stepName(h.step)}: ${h.reason}`).join('; ')]);
  rows.push(['Игра', `${num(g.fps) ? Math.round(g.fps) : '—'} к/с · качество ${p.tier || g.quality || '—'}${p.auto === false || g.qualityAuto === false ? '' : ' (авто)'} · разрешение ${num(p.scale) ? `${Math.round(p.scale * 100)}%` : '—'}${g.warm ? ' · дешёвый кадр на время запуска камеры' : ''}${g.fightCap ? ' · 30 к/с ради распознавания' : ''}`]);
  rows.push(['Видеокарта', `${p.gpu || '—'}${p.gpuClass ? ` (${p.gpuClass})` : ''}`]);
  const stage = d.loadStage ? `${d.loadStage}` : '—';
  rows.push(['Запуск', `этап ${stage} · прогрев ${num(d.warmupMs) ? `${Math.round(d.warmupMs)} мс` : '—'} · первый ответ ${num(d.firstResultMs) ? `${Math.round(d.firstResultMs)} мс` : '—'}`]);
  const h = t.hands && typeof t.hands === 'object' ? t.hands : null;
  if (h && h.enabled) rows.push(['Кисти', h.ready ? `распознаются${h.delegate ? ` (${h.delegate})` : ''}` : `нет${h.error ? ` — ${String(h.error).slice(0, 80)}` : ''}`]);
  return rows;
}

// Отчёт для «Скопировать отчёт»: всё, что нужно, чтобы понять, почему «игра не видит камеру», без видео и без личных данных
// (адрес — без параметров запроса).
export function reportText(tracking, diag, o = {}) {
  const t = tracking && typeof tracking === 'object' ? tracking : {};
  const d = t.debug && typeof t.debug === 'object' ? t.debug : {};
  const g = diag && typeof diag === 'object' ? diag : {};
  const p = g.perf && typeof g.perf === 'object' ? g.perf : {};
  const now = o.now instanceof Date ? o.now : new Date();
  const lines = ['ASHEN OATH — отчёт камеры', `Время: ${now.toISOString()}`];
  lines.push(`Адрес: ${g.url || '—'} · защищённый: ${g.secure === false ? 'нет' : g.secure ? 'да' : '—'} · встроенное окно: ${g.embedded ? 'да' : 'нет'}`);
  if (g.ua) lines.push(`Браузер: ${g.ua}`);
  lines.push(`Экран: ${g.screen || '—'} · статус: ${t.status || '—'} — ${t.message || ''}${t.error ? ` (код ${t.error})` : ''}`);
  for (const [k, v] of diagRows(t, g)) lines.push(`${k}: ${v}`);
  lines.push(`Распознавание: результатов ${num(d.results) ? d.results : '—'}, ошибок ${num(d.errors) ? d.errors : '—'}, пропущено (занят) ${num(d.skippedBusy) ? d.skippedBusy : '—'}, цикл ${d.loopMode || '—'}${d.rvfcStarved ? ' (rVFC молчал)' : ''}`);
  lines.push(`Модель позы: ${d.poseModel || '—'} · MediaPipe ${d.mediaPipe && d.mediaPipe.version ? d.mediaPipe.version : '—'} · ступени ${Array.isArray(d.ladder) ? d.ladder.join(' → ') : '—'}`);
  if (d.workerFallbackReason) lines.push(`Причина без GPU-воркера: ${d.workerFallbackReason}`);
  if (d.engineNote) lines.push(`Заметка движка: ${d.engineNote}`);
  lines.push(`Железо: ядер ${num(p.cores) ? p.cores : '—'}, память ${num(p.memory) ? `${p.memory} ГБ` : '—'}, экран ${num(p.refreshHz) ? `${p.refreshHz} Гц` : '—'}, предел ${num(p.capFps) ? `${p.capFps} к/с` : '—'}, GPU кадра ${num(p.gpuMs) ? `${p.gpuMs} мс` : '—'}`);
  if (g.offline) lines.push(`Офлайн: service worker ${g.offline.sw || '—'}, предзагрузка ${g.offline.preload || '—'}`);
  if (Array.isArray(g.warmLog) && g.warmLog.length) lines.push(`Дешёвый кадр: ${g.warmLog.map((w) => `${w.on ? 'вкл' : `выкл через ${(w.ms / 1000).toFixed(1)} с`} (${w.screen}, ${w.status})`).join('; ')}`);
  if (g.guard) lines.push(`Страж трекинга в бою: ступень ${g.guard.level}${g.guard.log && g.guard.log.length ? ` — ${g.guard.log.map((l) => l.text).join('; ')}` : ''}`);
  return lines.join('\n');
}
