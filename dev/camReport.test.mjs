// ASHEN OATH — dev/camReport.test.mjs [W5-КАМЕРА]
// Запуск: node dev/camReport.test.mjs
// Экран камеры: «что делать» по коду каждой ошибки vision.js, подсказки во время запуска, строки «Диагностики»
// и текст «Скопировать отчёт» (modules/camReport.js). Коды и тексты ошибок — настоящие, из modules/vision.js.
import { cameraAdvice, startupHint, diagRows, reportText, stepName } from '../modules/camReport.js';
import { mapCameraError } from '../modules/vision.js';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 3).join('\n     ')}`); }
}
function ok(c, m) { if (!c) throw new Error(m || 'условие не выполнено'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ожидалось'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// все коды ошибок, которые vision.js ставит в статус (fail(code, …) и mapCameraError)
const VISION_SRC = readFileSync(new URL('../modules/vision.js', import.meta.url), 'utf8');
const failCodes = [...VISION_SRC.matchAll(/fail\('([a-z-]+)'/g)].map((m) => m[1]);
const mapCodes = [...VISION_SRC.matchAll(/code: '([a-z-]+)'/g)].map((m) => m[1]);
const ALL = [...new Set([...failCodes, ...mapCodes])];

test('R01 у каждой ошибки камеры из vision.js есть свой «что делать»: заголовок, причина, шаги', () => {
  ok(ALL.length >= 9, `кодов найдено: ${ALL.join(', ')}`);
  for (const code of ALL) {
    const a = cameraAdvice(code, 'текст');
    ok(a, `нет совета для ${code}`);
    ok(a.title && a.reason && a.steps.length >= 1, `${code}: неполный совет`);
    ok(a.kind !== 'generic' && !/непредвиденн|что-то пошло/i.test(a.title), `${code}: общий совет вместо конкретного`);
  }
  eq(cameraAdvice('нет-такого', ''), null, 'неизвестный код — прежний разбор по словам (ui.js explainError)');
});

test('R02 тексты mapCameraError и советы совпадают по смыслу (DOMException → код → совет)', () => {
  const cases = [
    ['NotAllowedError', 'denied', /запрещён/], ['NotReadableError', 'busy', /занята/], ['NotFoundError', 'nocamera', /не найдена/],
    ['AbortError', 'busy', /занята/], ['TypeError', 'unsupported', /Браузер/], ['WeirdError', 'camera', /не включилась/],
  ];
  for (const [name, kind, title] of cases) {
    const m = mapCameraError(Object.assign(new Error(name), { name }));
    const a = cameraAdvice(m.code, m.message);
    eq(a.kind, kind, `${name} → ${m.code}`);
    ok(title.test(a.title), `${name}: ${a.title}`);
  }
});

test('R03 встроенное окно (превью VS Code): запрет камеры — совет открыть в отдельной вкладке, а не «разрешите у адреса»', () => {
  const a = cameraAdvice('permission-denied', 'Доступ к камере запрещён', { embedded: true });
  eq(a.kind, 'iframe');
  ok(a.steps.some((s) => /отдельной вкладке/.test(s)), a.steps.join(' | '));
  const b = cameraAdvice('embedded-blocked', '');
  eq(b.kind, 'iframe');
  const c = cameraAdvice('permission-denied', '');
  ok(c.steps.some((s) => /значок камеры/.test(s)), 'в обычной вкладке — разрешить у адресной строки');
});

test('R04 model-failed: загрузка — «интернет / локальный запуск», сбой во время работы — «распознавание остановилось» и отчёт', () => {
  const load = cameraAdvice('model-failed', 'Не удалось загрузить модель распознавания позы. Проверьте интернет и обновите страницу.');
  eq(load.kind, 'model');
  ok(load.steps.some((s) => /START_GAME/.test(s)), 'офлайн-запуск');
  const run = cameraAdvice('model-failed', 'Распознавание позы остановилось и не перезапустилось. Обновите страницу.');
  eq(run.kind, 'model-run');
  ok(run.steps.some((s) => /Скопировать отчёт/.test(s)), 'просим отчёт');
});

test('R05 запуск: «что делать» появляется по делу и не раньше времени', () => {
  eq(startupHint({ status: 'loading', message: 'Загрузка модели позы…' }, { sinceMs: 3000 }), null, 'обычная загрузка — без советов');
  ok(/дольше обычного/.test(startupHint({ status: 'loading', message: 'Проверка распознавания…' }, { sinceMs: 25000 }).text), 'долго');
  ok(/Видеокарта занята/.test(startupHint({ status: 'loading', message: 'Видеокарта не успевает — распознавание переходит на процессор…' }, { sinceMs: 100 }).text), 'переход по лестнице');
  ok(/Медленная сеть/.test(startupHint({ status: 'loading', message: 'Загрузка распознавания: 3,2 МБ…' }, { sinceMs: 16000 }).text), 'медленная сеть');
  eq(startupHint({ status: 'permission', message: '' }, { sinceMs: 2000 }), null, 'запрос только что показан');
  ok(/превью/.test(startupHint({ status: 'permission', message: '' }, { sinceMs: 9000, embedded: true }).steps[0]), 'встроенное окно');
  eq(startupHint({ status: 'lost', message: 'Нет новых кадров с камеры' }).tone, 'bad');
  ok(/шторку/.test(startupHint({ status: 'lost', message: 'Нет новых кадров с камеры' }).steps[0]), 'камера молчит');
  ok(/снижает графику/.test(startupHint({ status: 'lost', message: 'Распознавание не успевает за камерой' }).steps[0]), 'не успевает');
  eq(startupHint({ status: 'lost', message: 'Не видно плеч — сядьте в кадр' }), null, 'обычная потеря — подсказывает рамка');
  eq(startupHint({ status: 'ready', message: 'Трекинг активен' }), null);
});

const TRACK = {
  status: 'ready', message: 'Трекинг активен', error: null, mode: 'worker', delegate: 'CPU',
  hands: { enabled: true, ready: true, delegate: 'CPU', error: null },
  debug: {
    cameraFps: 29.7, inferenceHz: 24.4, inferMs: 18.2, latencyMs: 41, video: { w: 640, h: 480 }, cameraFallback: null,
    engineStep: 'worker-cpu', ladder: ['worker-gpu', 'worker-cpu', 'main-gpu', 'main-cpu'],
    ladderHistory: [{ step: 'worker-gpu', reason: 'worker молчит 15 с (этап: warmup)', atMs: 1234 }], ladderSwitching: false,
    loadStage: 'warmup', warmupMs: 90, firstResultMs: 420, results: 300, errors: 0, skippedBusy: 12, loopMode: 'rvfc',
    poseModel: 'lite', mediaPipe: { version: '0.10.35' }, workerFallbackReason: 'worker молчит 15 с (этап: warmup)',
  },
};
const DIAG = {
  fps: 58, quality: 'medium', qualityAuto: true, warm: true, fightCap: false,
  perf: { tier: 'medium', scale: 0.85, capFps: 60, fps: 59, gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620)', gpuClass: 'integrated', cores: 8, memory: 8, refreshHz: 60, gpuMs: 7.1, auto: true },
  secure: true, embedded: false, url: 'https://diiaanns07-droid.github.io/ADMIT_STUTU/', ua: 'Mozilla/5.0 Chrome/140', offline: { sw: 'active', preload: 'done' },
  warmLog: [{ on: true, screen: 'camera', status: 'loading', ms: 0 }, { on: false, screen: 'camera', status: 'ready', ms: 6400 }], guard: { level: 0, log: [] },
};

test('R06 «Диагностика»: частота камеры, распознаваний в секунду, воркер/главный поток, GPU/CPU, FPS игры', () => {
  const rows = Object.fromEntries(diagRows(TRACK, DIAG));
  ok(/29,7 к\/с/.test(rows['Камера']) && /640×480/.test(rows['Камера']), rows['Камера']);
  ok(/24,4 в секунду/.test(rows['Распознаваний']), rows['Распознаваний']);
  ok(/воркер/.test(rows['Где считается']) && /процессор \(CPU\)/.test(rows['Где считается']), rows['Где считается']);
  ok(/2 из 4/.test(rows['Ступень отката']), rows['Ступень отката']);
  ok(/воркер · видеокарта: worker молчит 15 с/.test(rows['Откаты']), rows['Откаты']);
  ok(/^58 к\/с/.test(rows['Игра']) && /дешёвый кадр/.test(rows['Игра']), rows['Игра']);
  ok(/UHD Graphics 620/.test(rows['Видеокарта']), rows['Видеокарта']);
  ok(/распознаются/.test(rows['Кисти']), rows['Кисти']);
  const noCam = Object.fromEntries(diagRows({ ...TRACK, debug: { ...TRACK.debug, cameraFps: null, camera: { fps: null, videoFps: 19.9, fresh: true } } }, DIAG));
  ok(/19,9 к\/с \(плеер\)/.test(noCam['Камера']), `основной поток не успевает — частота по плееру: ${noCam['Камера']}`);
  const empty = diagRows(null, null);
  ok(empty.length >= 5 && empty.every(([k, v]) => typeof k === 'string' && typeof v === 'string'), 'без данных — прочерки, не падает');
});

test('R07 отчёт: всё для разбора «игра не видит камеру», без параметров адреса; основной поток и GPU', () => {
  const t = reportText(TRACK, { ...DIAG, screen: 'camera' }, { now: new Date('2026-10-03T10:00:00Z') });
  for (const re of [/ASHEN OATH — отчёт камеры/, /2026-10-03T10:00:00/, /github\.io\/ADMIT_STUTU\//, /статус: ready/, /Распознаваний: 24,4/, /worker-gpu → worker-cpu → main-gpu → main-cpu/, /Причина без GPU-воркера: worker молчит 15 с/, /Железо: ядер 8/, /Офлайн: service worker active/, /Дешёвый кадр: вкл .*выкл через 6\.4 с/]) ok(re.test(t), `нет ${re} в отчёте:\n${t}`);
  ok(t.split('\n').length < 30, 'отчёт короткий — влезет в сообщение');
  const main = reportText({ ...TRACK, mode: 'main', delegate: 'GPU', status: 'error', error: 'model-failed', message: 'Сбой' }, DIAG);
  ok(/основной поток · видеокарта \(GPU\)/.test(main) && /код model-failed/.test(main), main);
  eq(stepName('main-cpu'), 'основной поток · процессор');
});

console.log(`\nИтог: ${passed} пройдено, ${failed} не пройдено.`);
process.exitCode = failed ? 1 : 0;
