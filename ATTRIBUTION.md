# ATTRIBUTION

## Сторонние библиотеки
Загружаются с CDN при запуске, в архив не входят.

| Компонент | Версия | Источник | Лицензия |
|---|---|---|---|
| three.js | 0.185.1 (r185) | https://cdn.jsdelivr.net/npm/three@0.185.1/ | MIT, © 2010-2026 three.js authors |
| MediaPipe Tasks Vision | 0.10.35 | https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/ | Apache-2.0, © Google LLC |
| Pose Landmarker (lite, float16, v1) | 1 | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task | модель Google MediaPipe; условия — в карточке модели на developers.google.com/edge/mediapipe |
| Hand Landmarker (float16, v1) | 1 | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task | модель Google MediaPipe; условия — в карточке модели |

MediaPipe 1.0.x **сознательно не используется**: в его JS-бандле есть отправка метрик
использования на `odml.pa.googleapis.com/v1/log`.

## Модули проекта
| Файл | Автор | Правки при интеграции (№1) |
|---|---|---|
| `modules/vision.js`, `modules/vision-worker.js` | №2 | MediaPipe 0.10.35; HandLandmarker в worker; слияние поза+кисти в read(); getPose/getHands |
| `modules/world.js` | №3 | V1 по Visual Bible: босс пересобран в Регента Нимба на прежнем скелете (маска, нимб, мантия, позвонки, каменные кисти); PBR-пол с лужами; обрыв плато, колоссы, шпили, рёбра купола; ключевой свет от затмения; rim-свет персонажей |
| `modules/atmosphere.js` | №1 | новый: небо с затмением, высотный туман со свечением (в шейдерах материалов), море тумана, световые столбы, IBL из неба |
| `modules/combat.js` | №4 | руны, сила выброса, комбо, идеальный рывок, оберег, оглушение |
| `modules/boss.js` | №5 | нет |
| `modules/effects.js` | №6 | обработчики rune_cast, perfect_dodge, ward_end; размеры свечения чар и волн броска под порог bloom 1.0 |
| `modules/ui.js`, `modules/ui.css` | №7 | тексты обучения/плиток под пальцы; русские ключевые слова ошибок; `@media (max-height: 680px)`; имя босса «Регент Нимба»; карточка «Чары двумя руками», сетка обучения 3+2 |
| `main.js`, `config.js`, `core/*` (cameraRig, debugInput, handGestures, trackingHud, battleHud), `index.html`, `styles.css`, `serve_game.py`, `START_GAME.cmd`, `tools/*` | №1 | — |
| `dev/*` (тесты и стенды) | №2–№7 | пути импорта → `../modules/`; в стендах three → 0.185.1; в `vision.test.mjs` ожидаемые версии → 0.10.35 |

## Тестовые данные (только в `dev/`, в игре не используются)
`dev/fixtures/hands/hagrid_images.json` — числовые координаты кистей, извлечённые MediaPipe из
179 изображений датасета **HaGRID** (SberDevices, CC BY-SA 4.0, https://github.com/hukenovs/hagrid).
Сами фотографии не распространяются. Подробности — `dev/fixtures/hands/SOURCES.md`.

## Текстуры (в архиве, CC0)
Два набора PBR-текстур 1K с **Poly Haven** (https://polyhaven.com), лицензия **CC0 1.0**
(общественное достояние, указание автора не требуется): `dark_rock_02` и `monastery_stone_floor`. Список страниц и где что используется — `assets/polyhaven/LICENSE.md`.
Если файлы не загрузились, игра остаётся на процедурных текстурах.

## Модель героя (в архиве, CC0)
`assets/kaykit/Mage.glb` — персонаж «Mage» с анимациями из **KayKit : Adventurers Character Pack 1.0**,
автор **Kay Lousberg** (https://kaylousberg.com), лицензия **CC0 1.0**,
источник: https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 (текст — `assets/kaykit/LICENSE.txt`).
Цвета материалов приглушены под сцену, анимации смешиваются в `modules/heroModel.js`.
Если файл не загрузился, остаётся процедурный герой.

## Собственные ресурсы
Вся геометрия процедурная (включая Регента, колоссов и шпили), небо с затмением и туман — шейдеры,
остальные текстуры рисуются на Canvas во время запуска, звук синтезируется через Web Audio.
Внешних моделей, шрифтов и звуковых файлов нет. Ресурсы коммерческих игр не используются.
Арт-дирекшн — документы владельца проекта (`AAA Visual Bible`, спецификации жестов); сводка — `CANON.md`.

## Референсы настроения
Black Myth: Wukong и Hogwarts Legacy — только ориентир по настроению. Персонажи, модели, музыка,
интерфейс и названия не заимствовались.
