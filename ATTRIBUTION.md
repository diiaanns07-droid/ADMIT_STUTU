# ATTRIBUTION

## Сторонние библиотеки
Копии лежат в `vendor/` (пути повторяют CDN, собираются `tools/vendor_update.mjs`) и раздаются вместе
с игрой — интернет не нужен. Указанный источник — откуда взяты файлы и запасной адрес, если локальный не загрузился.

| Компонент | Версия | Источник | Лицензия |
|---|---|---|---|
| three.js | 0.185.1 (r185) | https://cdn.jsdelivr.net/npm/three@0.185.1/ | MIT, © 2010-2026 three.js authors |
| MediaPipe Tasks Vision | 0.10.35 | https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/ | Apache-2.0, © Google LLC |
| Pose Landmarker (lite, float16, v1) | 1 | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task | модель Google MediaPipe; условия — в карточке модели на developers.google.com/edge/mediapipe |
| Pose Landmarker (full, float16, v1) [PERF] | 1 | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task (грузится вместо lite только на дискретной видеокарте, core/perfTuner.js) | модель Google MediaPipe; условия — в карточке модели |
| Hand Landmarker (float16, v1) | 1 | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task | модель Google MediaPipe; условия — в карточке модели |
| @pixiv/three-vrm | 3.5.5 | https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3.5.5/ | MIT, © 2019-2026 pixiv Inc. |
| Шрифты Forum, Cinzel, Alegreya Sans, Cormorant Garamond (woff2, латиница и кириллица) | Google Fonts | https://fonts.google.com/ → `vendor/fonts/` | SIL Open Font License 1.1 |
| PeerJS [NET] | 1.5.5 | https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js (грузится только в режиме «Онлайн-дуэль → Интернет»); сигнальный сервер — облако PeerJS 0.peerjs.com; STUN — stun.l.google.com | MIT, © 2013 Michelle Bu, Eric Zhang and PeerJS contributors |

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
| `modules/sfx.js`, `tools/sfx_bake.mjs`, `tools/sfx_dsp.mjs`, `assets/sfx/*` | [SFX] | новые: звук на сэмплах, «режиссёр» событий боя, кнопка «Без звука» и клавиша M |
| `modules/ui.js`, `modules/ui.css` | №7 | тексты обучения/плиток под пальцы; русские ключевые слова ошибок; `@media (max-height: 680px)`; имя босса «Регент Нимба»; карточка «Чары двумя руками», сетка обучения 3+2 |
| `main.js`, `config.js`, `core/*` (cameraRig, debugInput, handGestures, trackingHud, battleHud), `index.html`, `styles.css`, `serve_game.py`, `START_GAME.cmd`, `tools/*` | №1 | — |
| `net/*`, `modules/remotePlayer.js`, `modules/netLobby.js`, `modules/netLobby.css`, `tools/relay.py`, `START_ONLINE_HOST.cmd` | №2 [NET] | новые (онлайн-дуэль) |
| `dev/*` (тесты и стенды) | №2–№7 | пути импорта → `../modules/`; в стендах three → 0.185.1; в `vision.test.mjs` ожидаемые версии → 0.10.35 |

## Тестовые данные (только в `dev/`, в игре не используются)
`dev/fixtures/hands/hagrid_images.json` — числовые координаты кистей, извлечённые MediaPipe из
179 изображений датасета **HaGRID** (SberDevices, CC BY-SA 4.0, https://github.com/hukenovs/hagrid).
Сами фотографии не распространяются. Подробности — `dev/fixtures/hands/SOURCES.md`.

## Текстуры (в архиве, CC0)
Два набора PBR-текстур 1K с **Poly Haven** (https://polyhaven.com), лицензия **CC0 1.0**
(общественное достояние, указание автора не требуется): `dark_rock_02` и `monastery_stone_floor`. Список страниц и где что используется — `assets/polyhaven/LICENSE.md`.
Если файлы не загрузились, игра остаётся на процедурных текстурах.

## Герои и эльфы (в архиве, CC0)
- `assets/vroid/*.vrm` — ранние образцы **VRoid Studio** (pixiv), выпущенные под **CC0 1.0**:
  AvatarSample_F (эльфийка), Darkness (тёмная чародейка), AvatarSample_E и _G (жительницы деревни).
  Источник и условия — `assets/vroid/LICENSE.md`. Текстуры уменьшены (`tools/shrink_vrm.py`).
  Загрузка — **@pixiv/three-vrm 3.5.5** (MIT, копия в `vendor/`): физика волос и одежды, моргание.
- `assets/quaternius/human.glb`, `woman.glb` — «Animated Human» и «Animated Woman» от **Quaternius**
  (CC0 1.0, Poly Pizza; ссылки — `assets/quaternius/LICENSE.md`). Их анимации (шаг, бег, удар, прыжок,
  смерть, сидя…) переносятся на VRM-персонажей по направлениям костей (`modules/vrmKit.js`).
- Если модель не загрузилась, остаётся процедурный Пепельный страж.
- [HERO] `assets/heroes/knight.glb`, `wizard.glb`, `ranger.glb` — тела и костюмы **Quaternius** (Modular
  Character Outfits — Fantasy, Universal Base Characters), **CC0 1.0**: Пепельный страж (латы Knight),
  Архимаг (Wizard), Лучница (Ranger). `assets/heroes/anims_kaykit.glb` — 35 клипов **KayKit Adventurers 1.0**
  (Kay Lousberg, **CC0 1.0**), меши убраны. Источники и ссылки на лицензии — `assets/heroes/LICENSE.md`.
  Снаряжение (плащи, посохи, лук, наплечники, пояса) — процедурное (`modules/heroGear.js`).

## Звук (в архиве, собственный)
`assets/sfx/*.ogg` — 40 звуков игры (шаги, щит, выстрел, искра, рассечение, выброс, руны, попадания, рывок,
парирование, «Распознано», «ОШИБКА», фанфары, эмбиент арены). Чужих сэмплов и записей нет: все звуки синтезированы
офлайн нашим кодом (`tools/sfx_dsp.mjs`: генераторы, фильтры, сатурация, модальный синтез металла, ревербация;
рецепты — `tools/sfx_bake.mjs`), закодированы в Ogg Vorbis через ffmpeg (libvorbis). Передаются в общественное
достояние на условиях **CC0 1.0**. Пересобрать: `node tools/sfx_bake.mjs` (нужен ffmpeg).
Звуки без файла (замах и удары Регента, сотворение сферы) и запасной вариант на случай, если файл не загрузился,
синтезируются прямо в браузере через Web Audio (`modules/effects.js`).

## Собственные ресурсы
Геометрия мира процедурная (включая Регента, колоссов, шпили и эльфийскую деревню), небо с затмением и туман — шейдеры,
остальные текстуры рисуются на Canvas во время запуска, звуки — свои (см. «Звук» выше).
Внешние модели — только герои и эльфы (CC0, см. выше); шрифтов нет.
Ресурсы коммерческих игр не используются. Арт-дирекшн — документы команды (визуальная библия, спецификации жестов).

## Референсы настроения
Black Myth: Wukong и Hogwarts Legacy — только ориентир по настроению. Персонажи, модели, музыка,
интерфейс и названия не заимствовались.
