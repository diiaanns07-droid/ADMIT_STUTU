# ASHEN OATH · V6 — промпты для 8 агентов на 5 часов

## Как запускать
1. Открой 8 сессий Claude Code (claude.ai/code) на репозитории `diiaanns07-droid/ADMIT_STUTU`, ветка `main`.
2. В каждую сессию вставь один промпт ниже целиком: каждый самодостаточен, общие правила и контракты уже внутри.
3. Первыми запусти №2 и №3 (онлайн): это критический путь к завтрашней дуэли.
4. Контрольные точки (T0 — момент старта агента): T+1:15, T+2:30 и T+3:45 — каждый вливает работу в `main`; T+4:15 — заморозка фич; T+4:45 — финальное вливание.
5. Кто освободится раньше, отдай ему промпт №9 «Интегратор». Если свободных нет, в T+4:00 дай его агенту №1.

| № | Тег | Зона | Основные файлы |
|---|---|---|---|
| 1 | [CTRL] | Движение и камера | core/steerStick.js, leftStick.js, cameraRig.js, headLook.js |
| 2 | [NET] | Онлайн: сеть, лобби, второй игрок | net/, modules/netLobby.js, remotePlayer.js, tools/relay.py |
| 3 | [PVP] | Дуэль: попадания, урон, раунды | modules/pvp.js + хуки в combat.js |
| 4 | [HERO] | Красивые герои, анимации, снаряжение | modules/heroModel.js, vrmKit.js, characterLooks.js |
| 5 | [FOREST] | Карта «Сияющий лес» + поляна дуэлей | modules/brightForest.js |
| 6 | [HAND] | Лук рукой + магия, которую лепишь рукой | core/bowGesture.js, handMagic.js, handFxOverlay.js, modules/combatHand.js |
| 7 | [VFX] | Визуал каждой руны и заклинания | modules/effects.js, modules/fx/ |
| 8 | [BDO] | Интерфейс, HUD и картинка в стиле Black Desert | modules/ui.js, ui.css, core/battleHud.js, postfx.js, atmosphere.js |
| 9 | [FIX] | Интегратор (последний час) | всё, только исправления |

## Завтра: как подраться по сети
- **Интернет:** оба открывают https://diiaanns07-droid.github.io/ADMIT_STUTU/ → «Онлайн-дуэль» → один создаёт комнату, второй вводит код.
- **Если прямое соединение не проходит** (гостевой Wi-Fi часто режет P2P): раздайте интернет с телефона обоим, или LAN-режим — хост запускает START_ONLINE_HOST.cmd, оба открывают игру локально (`python serve_game.py`, иначе браузер не даст камеру), гость вводит IP хоста.

---

## Промпт №1 · [CTRL] Движение корпусом во все стороны

````text
# ТВОЯ РОЛЬ: №1 [CTRL] — движение через камеру: вперёд, назад, влево, вправо

Требование владельца (дословно): «движения я хочу как раз таки через CV, но чтобы двигаться от души — и направо, и налево, и назад, и вперёд». Клавиатуры, мыши и геймпада в бою НЕТ, только камера. Раньше он жаловался, что джойстиком левой руки управлять сложно. Сейчас: «Руль» (core/steerStick.js, по умолчанию) — хода назад и стрейфа нет совсем, `fwd = max(0, iz)` в combat.js; поворот — это скорость, как у руля машины. «Джойстик» (core/leftStick.js) — «подними руку и замри», мелкий ход руки.

**Схема уже выбрана — режим «Корпус».** Её сравнили с тремя другими (левая рука 2.0, стоя всем телом, гибрид), и оба судьи выбрали её. Игрок сидит, руки свободны для магии:
- наклон корпуса вправо или влево → стрейф вправо или влево;
- подался к экрану → вперёд;
- откинулся назад → назад;
- диагонали работают;
- сильнее наклон → бег;
- резкий качок корпусом вбок → уклон вбок;
- уклон вперёд или назад → вертикальный дёрг левой рукой.
Спецификация с числами, рабочий прототип и 3D-симулятор лежат в ветке `claude/brave-noether-15sogk`. Забери их первой командой:
`git fetch origin claude/brave-noether-15sogk && git checkout origin/claude/brave-noether-15sogk -- dev/ctrl-torso`
- `dev/ctrl-torso/VERDICT.md` — итоговые решения и числа двух судей. **Это главный документ.** Если судьи расходятся, бери вариант судьи «engineer» и пересадки судьи «player»: утечку нейтрали глубины, пятиться в explore, fwdOn 0,45.
- `dev/ctrl-torso/design_torso.md` — полная спецификация и план на 4 часа;
- `dev/ctrl-torso/sim2.mjs` — прототип алгоритма и симулятор сидящего игрока (шум, задержка, 6–30 fps): `node dev/ctrl-torso/sim2.mjs --seeds=20 --fps=6,10,15,30`, сравнение со старым режимом — `--old`;
- `dev/ctrl-torso/signals.md` и `conflicts.md` — какие сигналы тела есть в vision.js и какие жесты могут ложно сдвинуть героя.
Замер прототипа при 10 fps: старт хода 0,32–0,43 с, стоп ~0,3 с, оси держатся 97–100 %, уклон вбок 5/5, ложных сдвигов от руны, взмаха, броска и поворота головы 0–0,5 %. Известные дыры: отъезд на кресле назад даёт бесконечный ход (66 % кадров), а в покое набегает дрейф 0,19 м за 20 с. Обе нужно закрыть.

Задачи по порядку:
1. **Сквозная проводка `moveMode:'torso'` (0:00–0:20):** main.js sanitizeSettings, config.js, combat.js (`'torso'` → семантика «Джойстика»: steer=false, замок кадра, автодоворот камеры через 0,6 с), vision.js applyMoveMode и read(), пустой mover и steering() = 0 в handGestures, debugInput, пункт меню «Корпус» (ui.js — минимальный хук с тегом [CTRL]). Все `dev/*.test.mjs` должны быть зелёными.
2. **core/ctrlTorso.js** — порт прототипа из sim2.mjs по VERDICT.md. Что в нём:
   - свидетели и подтверждение: сдвиг плеч подтверждается креном или головой, глубина — расстоянием между ушами;
   - пороги от шума калибровки, притяжение к 8 направлениям, шаг/бег/спринт;
   - три блокировки на время колдовства: arm, strict, freeze;
   - armBias — поднятая правая рука не должна давать «вперёд»;
   - нейтраль: захват в конце калибровки, медленная подстройка, «руки вниз», **утечка нейтрали глубины** (лечит отъезд на кресле), смена посадки → `interp.adoptBaseline()` в vision.js;
   - уклон корпусом вбок; вертикальный дёрг левой руки для уклона вперёд и назад, с гейтами по щиту, парированию, двуручным чарам и луку (`input.bow.active`, C2);
   - потеря опор; коды «ОШИБКИ» `torso_*` в core/gestureCoach.js.
   Старый `torsoMove` в vision.js не включай и не удаляй: на нём тесты.
3. **dev/ctrlTorso.test.mjs** — симулятор из sim2.mjs и метрики приёмки из VERDICT.md:
   - покой 20 с — ход не больше 0,5 % кадров, уклонов 0;
   - помехи (руна, взмах, бросок, «OK», поворот и наклон головы, пожатие плечами) — не больше 2 %;
   - старт не дольше 450 мс при 10 fps, стоп не дольше 380 мс;
   - направление держится: оси ≥ 97 %, назад ≥ 90 %, диагонали назад ≥ 70 %;
   - уклон вбок ≥ 19/20 при 10–30 fps, 0 ложных;
   - бег + руна ≥ 98 %;
   - отъезд на кресле на 8 см → ход 0 не позже 6 с без действий игрока;
   - подался вперёд на 4 см → хода нет.
   Цифры «до/после» запиши в TEST_REPORT.md.
4. **Бой и PvP:**
   - в lock-on наклон вбок даёт кружение по орбите (×0,9), вперёд и назад — сближение и отход (×0,7), диагональ — спираль;
   - цель бери из `snap.lockTarget` (C4, соперник от №3), иначе — босс;
   - в explore ход назад = пятиться лицом вперёд ×0,7, камера не разворачивается;
   - щит на ходу ×0,5; со сферой или призмой ход ограничен 0,6, а не стоп;
   - в BUILD_STATUS запиши требование к №3: замах или снаряд соперника виден не меньше 0,7 с, потому что ввод корпусом запаздывает на 0,3–0,45 с.
5. **Обратная связь и обучение:**
   - индикатор внизу экрана — роза из 8 секторов и строка статуса «КОРПУС · ШАГ ← / БЕГ ↑ / СТОИТ / ЦЕНТР…». Сделай его в core/ctrlIndicator.js и вызови одной строкой из battleHud с тегом [CTRL]; стиль потом подтянет №8;
   - обучение на 30 с: сесть на середину стула, не опираясь на спинку, ноутбук на столе → вправо → влево → вперёд → назад → уклон → руна на бегу; записать личный максимум;
   - кнопка «Перекалибровать» в паузе.
6. **Камера (core/cameraRig.js):** плавное следование за спиной, автодоворот за движением, FOV +6° на спринте, lock-on по `snap.lockTarget` (цель всегда в кадре), коллизия с деревьями и стенами. Поворот камеры головой сделай опцией в настройках, по умолчанию выключенной. Этот пункт — после 1–5.
7. **Живая проверка — её делает владелец, у тебя камеры нет.** Сразу после первого вливания в main попроси владельца в чате:
   - открыть dev/vision-webcam-check.html или игру с включённым `getDebug()`;
   - 5 минут посидеть, наклоняясь во все стороны;
   - поднять правую руку с «OK», покрутиться корпусом на 20°, откинуться на спинку;
   - прислать цифры: σ сдвига плеч, ширины и ушей; ширину плеч при поднятой руке; реальный отклон назад; скорость качка.
   По ним подстрой latOn, fwdOn, backOn, κ и dashSpeed. Если «назад» не держится: backFull −10 % и ход назад только с подтверждением ушами.
8. **По умолчанию `moveMode:'torso'`.** «Руль» остаётся в меню как запасной под названием «Рука (руль)» — на случай ноутбука на коленях или шаткого стола. «Джойстик» — нижним пунктом.

Если время кончается, выкидывай по порядку: поворот камеры головой → личные диапазоны из обучения → уровень «одно плечо» → роза-HUD (оставить штатный индикатор). НЕ выкидывай: утечку глубины, armBias, adoptBaseline, freeze, steering() = 0.

Готово, когда: метрики приёмки пройдены в симуляторе; старые тесты зелёные (steer, leftStick, vision, handGestures, combat, qa_node); в DEBUG ничего не сломано; по живой проверке владельца герой уверенно идёт во все четыре стороны и кружит вокруг цели.

---

## ОБЩИЕ ПРАВИЛА (одинаковые у всех 8 агентов)

Проект — **ASHEN OATH**: браузерная 3D-игра в тёмном фэнтези, управление веб-камерой (руки и тело). Three.js 0.185 (importmap в index.html, без сборки, чистые ES-модули), MediaPipe Hands + Pose в Web Worker, VRM-герои (@pixiv/three-vrm). Статический сайт (GitHub Pages); локально — `python serve_game.py` → http://127.0.0.1:8765. В меню есть «Отладка с клавиатуры»: бой без камеры (WASD, Пробел, U/I/F и т. д., см. README).

Параллельно с тобой работают ещё 7 агентов, у всех 5 часов. Общая цель: к концу игра выглядит и играется как дорогая игра, максимально близко к Black Desert Online, и ЗАВТРА двое игроков дерутся по сети со своих ноутбуков.

**Старт (≤ 15 мин).** Первой командой выполни `date` и запомни это время как T0; все «T+…» ниже отсчитывай от него. Прочитай README.md, верх BUILD_STATUS.md, CANON.md, config.js, main.js и файлы своей зоны. Напиши в чат план из 5–8 пунктов и сразу начинай, подтверждения не жди.

**Git.**
- Работай в своей ветке сессии. Тебе ЯВНО РАЗРЕШЕНО вливать работу в `main`: `git fetch origin main && git merge origin/main` → тесты → проверка запуска → `git push origin HEAD:main`. Если push отклонён (кто-то успел раньше), повтори fetch, merge, проверку и push. В `main` никаких rebase и force-push.
- Вливай в main на контрольных точках T+1:15, T+2:30, T+3:45 и T+4:45. Между ними подтягивай main хотя бы раз в час, чтобы видеть чужие изменения.
- Коммиты мелкие, сообщения на русском, с тегом зоны: «[CTRL] …».
- При конфликте в общем файле сохраняй обе стороны. Чужие хуки не удаляй и не переписывай.

**Владение файлами (главное правило против конфликтов).**

| Тег | Агент | Свободно правит |
|---|---|---|
| [CTRL] | №1 Управление | core/steerStick.js, core/leftStick.js, core/cameraRig.js, core/debugInput.js, новые core/headLook.js, core/ctrl*.js |
| [NET] | №2 Сеть | новая папка net/, modules/netLobby.js, modules/netLobby.css, modules/remotePlayer.js, tools/relay.py |
| [PVP] | №3 Дуэль | новый modules/pvp.js, новые dev/pvp*.test.mjs |
| [HERO] | №4 Герои | modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/, assets/quaternius/, новые assets/heroes/, modules/heroShowcase.js |
| [FOREST] | №5 Лес | новый modules/brightForest.js, новые assets/forest/ |
| [HAND] | №6 Лук и магия рукой | новые core/bowGesture.js, core/handMagic.js, core/handFxOverlay.js, modules/combatHand.js |
| [VFX] | №7 Эффекты | modules/effects.js, новые modules/fx/*.js, dev/effects_testbench.html |
| [BDO] | №8 Стиль BDO | modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js, core/postfx.js, modules/atmosphere.js |

Общие «горячие» файлы ничьи: main.js, config.js, index.html, modules/combat.js, modules/world.js, core/handGestures.js, modules/vision.js. В них допустимы только маленькие точечные вставки (хуки), и каждую нужно пометить комментарием со своим тегом, например `// [CTRL] …`. Чужой код не переформатируй, не переименовывай и не переставляй. Большую логику выноси в новый файл своей зоны и вызывай его оттуда одной строкой. Новые ключи настроек добавляй отдельным блоком в конце sanitizeSettings в main.js, со своим тегом. Если чужой файл нужно менять сильнее, сделай минимальный хук, а в BUILD_STATUS опиши, что стоит доделать владельцу.

**Надёжность.**
- Всё новое прячь за настройкой в config.defaultSettings (ключ из контракта C1) и оборачивай в try/catch с откатом к старому поведению (так уже сделаны heroModel и postfx). После каждого твоего push в main игра обязана запускаться: меню → бой (DEBUG) без ошибок в консоли.
- Существующие жесты, руны, режим «ОШИБКА», тренировки и калибровка должны работать как прежде.
- Производительность: ноутбуки слабые, а MediaPipe уже нагружает GPU. На `medium` в бою нужно ≥ 40 fps на встроенной графике. Тяжёлое включай только на `high`. Уважай settings.quality и settings.reducedMotion. Используй инстансинг и пулы, не создавай объекты с new в каждом кадре.
- Ассеты — только CC0, MIT или CC-BY (с атрибуцией), каждый запиши в ATTRIBUTION.md. Файлы больше 5 МБ добавляй, только если без них никак, и сжимай (для VRM — tools/shrink_vrm.py).

**Проверка (в облаке нет камеры).**
- node-тесты: `for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done` — все должны проходить. Для своей части добавь новые.
- Браузер: Chromium лежит в /opt/pw-browsers (`find /opt/pw-browsers -name chrome -type f`). tools/qa_browser.mjs и tools/qa_shots.mjs принимают `--browser <путь>`. Можно написать и свой скрипт на Playwright в DEBUG-режиме со скриншотами. Смотри скриншоты сам: это твои глаза.
- Жесты проверяй синтетикой и фикстурами (dev/fixtures/hands, по образцу dev/handGestures*.test.mjs).

**Контракты между агентами (ниже).** Не ломай их, расширяй только добавлением полей. Если тебе нужно что-то из чужой зоны, а в main этого ещё нет, сделай у себя заглушку и работай дальше, не жди.

**T+4:15 — заморозка фич:** дальше только исправление багов, скорость и полировка. В конце добавь раздел «V6 · <твоя зона>» в BUILD_STATUS.md (что сделано, как проверить, что не успел) и строки в README.md, если меняется то, что видит игрок.

## КОНТРАКТЫ (общие для всех)

**C1. Настройки** (config.defaultSettings; main.js sanitizeSettings должен их пропускать):
`moveMode` — режим движения, ТОЛЬКО через камеру (набор значений задаёт №1 [CTRL]; клавиатура и мышь в бою не используются) · `camSens: 1` (CTRL) · `startZone: 'arena'|'forest'` (FOREST) · `bdoUi: true` (BDO) · `heroShading: 'realistic'|'anime'` (HERO) · `netName: ''` (NET).

**C2. Ввод** (объект input из vision/debugInput; main.js дополняет его до combat.update):
- `input.bow = { active, draw 0..1, aimX −1..1, aimY −1..1, charged, release (true один кадр), element|null }` — HAND
- `input.handSpell = { phase:'idle'|'form'|'hold'|'throw', element:'fire'|'storm'|'frost'|'earth', power 0..1, dir:{x,y} }` — HAND
- `input.camera = { yawRate, pitchRate, zoom }` — управление камерой телом или головой (CTRL)
- Пока `input.bow.active`, левая рука НЕ двигает героя (CTRL это уважает).

**C3. События боя** (форма `{id, type, position, data}`), новые типы:
- `bow_draw_start`, `bow_draw {draw}`, `bow_release {draw, charged, element}`, `arrow_hit {damage, element}` — HAND
- `hand_spell_form {element, power}`, `hand_spell_throw {element, power, dir}`, `hand_spell_hit {element, damage}`, `hand_spell_cancel` — HAND
- снаряды в snapshot.projectiles: kind `'arrow'` и `'hand_orb'` (+ поле element) — HAND
- `pvp_round {phase:'countdown'|'fight'|'round_end'|'match_end', round, score:[me, opp], winner}` — PVP
- `zone_enter {zoneId, name, subtitle}` — FOREST шлёт, BDO рисует титр зоны
- Каждое событие соперника, пришедшее по сети, получает `data.remote = true`: эффекты рисуют его в цвете соперника.

**C4. Snapshot** (combat.getSnapshot()):
- `snap.mode = 'boss'|'pvp'` (PVP)
- `snap.opponent = { id, name, hero, position, yaw, hp, maxHp, energy, maxEnergy, action, shielding, invulnerable, stunned, slowed } | null` (PVP заполняет из сети)
- `snap.lockTarget = { position, kind:'boss'|'player' }` — цель lock-on. Камера (CTRL) и HUD (BDO) берут цель отсюда, а не напрямую из snap.boss. Если поля нет, по умолчанию цель — босс.

**C5. Герой** (HERO, modules/heroModel.js):
- createHeroModel(...) можно вызывать несколько раз, у каждого экземпляра свой root (для удалённого игрока NET);
- `heroModel.update(dt, snapLike, events)` — от snapLike нужно только `{player:{…как в snapshot}}`;
- `heroModel.getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }` — THREE.Object3D в мире; к ним VFX и HAND крепят эффекты. У процедурного героя имена те же;
- `heroModel.setPose({ bowDraw 0..1, aim:{x,y}, handSpell 0..1 })` — поза лука или каста поверх анимаций.

**C6. Сеть** (NET, net/net.js):
- `createNet({transport:'peer'|'lan'|'local'})` → `{ host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn), close(), state ('idle'|'connecting'|'connected'|'lost'), ping, isHost }`
- Сообщения (JSON с полем t): `hello{v:'ASHEN_NET_1', name, hero}`, `st{…состояние 20 Гц}`, `ev{e}`, `hit{id, dmg, kind, fx, from, dir}`, `hitAck{id, applied, reason}`, `duel{phase, round, score, at}`, `ping`/`pong`.
- Транспорты: 'peer' — PeerJS через интернет по коду комнаты; 'lan' — WebSocket-ретранслятор tools/relay.py в локальной сети; 'local' — BroadcastChannel, две вкладки на одном ноутбуке (для тестов).

**C7. Карта** (FOREST, modules/brightForest.js — по образцу modules/elfVillage.js):
- `BRIGHT_FOREST = { id:'bright-forest', name:'Сияющий лес', x, z, r, level, duel:{ x, z, r, spawns:[{x,z,yaw},{x,z,yaw}] } }`
- `createBrightForest({THREE, scene, …})` → `{ colliders, groundAt(x,z), weight (0..1 — насколько герой внутри зоны), update(dt, heroPos), setQuality(q), dispose() }`
````

---

## Промпт №2 · [NET] Онлайн: соединение, лобби, второй игрок

````text
# ТВОЯ РОЛЬ: №2 [NET] — онлайн: соединение, лобби, удалённый игрок

Цель владельца: ЗАВТРА двое дерутся друг с другом со своих ноутбуков. Ты делаешь сеть и всё, что нужно, чтобы второй игрок появился в мире и живо двигался. Правила дуэли (урон, раунды) делает №3 [PVP]; вы работаете параллельно по контрактам C6, C3 и C4. Это критический путь всего проекта: первая рабочая версия (две вкладки видят друг друга) нужна к T+1:15, игра через интернет — к T+2:30.

Задачи:
1. **net/net.js по контракту C6 и три транспорта.**
   - 'local' — BroadcastChannel: две вкладки на одном ноутбуке (для тестов и для №3). Сделай его первым, за 30 минут, и сразу влей в main: на нём работает №3.
   - 'peer' — PeerJS с CDN jsdelivr. Закрепи версию, добавь её в config.DEPS и ATTRIBUTION. Хост получает код комнаты из 4–5 символов (без путаницы 0/O и 1/I), гость вводит код. Нужен STUN Google; бесплатный TURN, если найдётся, — опционально через конфиг. Таймауты и понятные ошибки по-русски, например: «Сеть не пускает прямое соединение — раздайте интернет с телефона или включите LAN-режим».
   - 'lan' — tools/relay.py: WebSocket-ретранслятор только на стандартной библиотеке Python (рукопожатие RFC 6455, комнаты по коду). Слушает 0.0.0.0:8790 и печатает IP ноутбука. ВАЖНО про камеру: getUserMedia работает только на https или localhost. Поэтому в LAN оба игрока открывают игру у себя через `python serve_game.py` (http://127.0.0.1…) и подключаются к ws://<IP хоста>:8790. Со страницы https (GitHub Pages) ws:// блокируется как mixed content — так и напиши в подсказке. Для Windows сделай START_ONLINE_HOST.cmd.
   - автовыбор: сначала 'peer', при неудаче предложить 'lan';
   - ping/pong, оценка RTT и смещения часов, heartbeat, обнаружение обрыва за 3 с, переподключение с тем же кодом.
2. **Синхронизация.** 20 раз в секунду шли пакет `st` из combat.getSnapshot().player: позиция, yaw, скорость, hp/maxHp, energy, action, locomotion, shielding, invulnerable, dashing, conjure, burstCharge, а также bow и handSpell из C2. Пакет компактный: округление, короткие ключи. Надёжными сообщениями `ev` пересылай локальные события боя, которые нужны сопернику для картинки: player_cast, player_slash, player_dash, shield_start/end, parry, burst, rune_cast, sigil_cast, bow_*, hand_spell_*, появление снарядов. Примерно 10 раз в секунду шли снимок своих снарядов (owner 'player'), чтобы соперник видел летящие заклинания.
3. **modules/remotePlayer.js — второй герой в сцене.** Создаётся через createHeroModel (C5) на своём root, герой — тот, которого соперник выбрал в hello. Буфер интерполяции ~100 мс плюс короткая экстраполяция, сглаживание поворота, высота — по groundAt мира. Над головой табличка: имя и полоска HP (тёмная, с золотой каймой — стиль №8). При обрыве — призрачный силуэт. API: `createRemotePlayer({THREE, scene, world, heroFactory})` → `{ push(st), update(dt), getState() (для snap.opponent у №3), setVisible(on), dispose() }`.
4. **modules/netLobby.js (+ netLobby.css) — экран «Онлайн-дуэль».** Имя игрока (settings.netName), выбор героя (из HEROES), «Создать комнату» (крупный код и кнопка «Копировать»), «Войти по коду», режим «Интернет / LAN» (для LAN — поле IP хоста), статус и пинг, соперник (имя, герой), кнопка «Готов» у обоих → старт (сообщаешь №3 через колбэк onReady). Кнопку «Онлайн-дуэль» добавь в главное меню ui.js минимальным хуком с тегом [NET]: ui.js принадлежит №8, стиль потом подтянет он. Но оформляй сразу в духе BDO: тёмные полупрозрачные панели, тонкая золотая рамка, шрифт с засечками.
5. **Подключение в main.js** (хуки с тегом [NET]). Сеть создаётся по кнопке. Каждый кадр отправляется st; входящие пакеты идут в remotePlayer.push; события соперника с `data.remote=true` добавляются в общий массив events перед world.update и effects.update. В одиночной игре сеть не создаётся вообще, накладных расходов ноль.
6. **Проверка.** Сделай dev/net-two-tabs.html или Playwright-скрипт: две вкладки с 'local', обе в DEBUG; одна ходит на WASD, вторая должна видеть движение, анимацию и снаряды. 'lan' проверь двумя headless-контекстами и tools/relay.py. Добавь в 'local' искусственную задержку и потери пакетов для тестов.
7. **README:** раздел «Играть вдвоём по сети» — пошагово на завтра. Вариант А: интернет, GitHub Pages, код комнаты. Вариант Б: одна Wi-Fi-сеть или раздача с телефона, LAN. Плюс типичные проблемы и их решения.

Готово, когда: две вкладки и два браузерных контекста видят друг друга плавно, без телепортов при пинге 150 мс и 5% потерь; обрыв и переподключение работают; одиночная игра не изменилась.

---

## ОБЩИЕ ПРАВИЛА (одинаковые у всех 8 агентов)

Проект — **ASHEN OATH**: браузерная 3D-игра в тёмном фэнтези, управление веб-камерой (руки и тело). Three.js 0.185 (importmap в index.html, без сборки, чистые ES-модули), MediaPipe Hands + Pose в Web Worker, VRM-герои (@pixiv/three-vrm). Статический сайт (GitHub Pages); локально — `python serve_game.py` → http://127.0.0.1:8765. В меню есть «Отладка с клавиатуры»: бой без камеры (WASD, Пробел, U/I/F и т. д., см. README).

Параллельно с тобой работают ещё 7 агентов, у всех 5 часов. Общая цель: к концу игра выглядит и играется как дорогая игра, максимально близко к Black Desert Online, и ЗАВТРА двое игроков дерутся по сети со своих ноутбуков.

**Старт (≤ 15 мин).** Первой командой выполни `date` и запомни это время как T0; все «T+…» ниже отсчитывай от него. Прочитай README.md, верх BUILD_STATUS.md, CANON.md, config.js, main.js и файлы своей зоны. Напиши в чат план из 5–8 пунктов и сразу начинай, подтверждения не жди.

**Git.**
- Работай в своей ветке сессии. Тебе ЯВНО РАЗРЕШЕНО вливать работу в `main`: `git fetch origin main && git merge origin/main` → тесты → проверка запуска → `git push origin HEAD:main`. Если push отклонён (кто-то успел раньше), повтори fetch, merge, проверку и push. В `main` никаких rebase и force-push.
- Вливай в main на контрольных точках T+1:15, T+2:30, T+3:45 и T+4:45. Между ними подтягивай main хотя бы раз в час, чтобы видеть чужие изменения.
- Коммиты мелкие, сообщения на русском, с тегом зоны: «[CTRL] …».
- При конфликте в общем файле сохраняй обе стороны. Чужие хуки не удаляй и не переписывай.

**Владение файлами (главное правило против конфликтов).**

| Тег | Агент | Свободно правит |
|---|---|---|
| [CTRL] | №1 Управление | core/steerStick.js, core/leftStick.js, core/cameraRig.js, core/debugInput.js, новые core/headLook.js, core/ctrl*.js |
| [NET] | №2 Сеть | новая папка net/, modules/netLobby.js, modules/netLobby.css, modules/remotePlayer.js, tools/relay.py |
| [PVP] | №3 Дуэль | новый modules/pvp.js, новые dev/pvp*.test.mjs |
| [HERO] | №4 Герои | modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/, assets/quaternius/, новые assets/heroes/, modules/heroShowcase.js |
| [FOREST] | №5 Лес | новый modules/brightForest.js, новые assets/forest/ |
| [HAND] | №6 Лук и магия рукой | новые core/bowGesture.js, core/handMagic.js, core/handFxOverlay.js, modules/combatHand.js |
| [VFX] | №7 Эффекты | modules/effects.js, новые modules/fx/*.js, dev/effects_testbench.html |
| [BDO] | №8 Стиль BDO | modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js, core/postfx.js, modules/atmosphere.js |

Общие «горячие» файлы ничьи: main.js, config.js, index.html, modules/combat.js, modules/world.js, core/handGestures.js, modules/vision.js. В них допустимы только маленькие точечные вставки (хуки), и каждую нужно пометить комментарием со своим тегом, например `// [CTRL] …`. Чужой код не переформатируй, не переименовывай и не переставляй. Большую логику выноси в новый файл своей зоны и вызывай его оттуда одной строкой. Новые ключи настроек добавляй отдельным блоком в конце sanitizeSettings в main.js, со своим тегом. Если чужой файл нужно менять сильнее, сделай минимальный хук, а в BUILD_STATUS опиши, что стоит доделать владельцу.

**Надёжность.**
- Всё новое прячь за настройкой в config.defaultSettings (ключ из контракта C1) и оборачивай в try/catch с откатом к старому поведению (так уже сделаны heroModel и postfx). После каждого твоего push в main игра обязана запускаться: меню → бой (DEBUG) без ошибок в консоли.
- Существующие жесты, руны, режим «ОШИБКА», тренировки и калибровка должны работать как прежде.
- Производительность: ноутбуки слабые, а MediaPipe уже нагружает GPU. На `medium` в бою нужно ≥ 40 fps на встроенной графике. Тяжёлое включай только на `high`. Уважай settings.quality и settings.reducedMotion. Используй инстансинг и пулы, не создавай объекты с new в каждом кадре.
- Ассеты — только CC0, MIT или CC-BY (с атрибуцией), каждый запиши в ATTRIBUTION.md. Файлы больше 5 МБ добавляй, только если без них никак, и сжимай (для VRM — tools/shrink_vrm.py).

**Проверка (в облаке нет камеры).**
- node-тесты: `for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done` — все должны проходить. Для своей части добавь новые.
- Браузер: Chromium лежит в /opt/pw-browsers (`find /opt/pw-browsers -name chrome -type f`). tools/qa_browser.mjs и tools/qa_shots.mjs принимают `--browser <путь>`. Можно написать и свой скрипт на Playwright в DEBUG-режиме со скриншотами. Смотри скриншоты сам: это твои глаза.
- Жесты проверяй синтетикой и фикстурами (dev/fixtures/hands, по образцу dev/handGestures*.test.mjs).

**Контракты между агентами (ниже).** Не ломай их, расширяй только добавлением полей. Если тебе нужно что-то из чужой зоны, а в main этого ещё нет, сделай у себя заглушку и работай дальше, не жди.

**T+4:15 — заморозка фич:** дальше только исправление багов, скорость и полировка. В конце добавь раздел «V6 · <твоя зона>» в BUILD_STATUS.md (что сделано, как проверить, что не успел) и строки в README.md, если меняется то, что видит игрок.

## КОНТРАКТЫ (общие для всех)

**C1. Настройки** (config.defaultSettings; main.js sanitizeSettings должен их пропускать):
`moveMode` — режим движения, ТОЛЬКО через камеру (набор значений задаёт №1 [CTRL]; клавиатура и мышь в бою не используются) · `camSens: 1` (CTRL) · `startZone: 'arena'|'forest'` (FOREST) · `bdoUi: true` (BDO) · `heroShading: 'realistic'|'anime'` (HERO) · `netName: ''` (NET).

**C2. Ввод** (объект input из vision/debugInput; main.js дополняет его до combat.update):
- `input.bow = { active, draw 0..1, aimX −1..1, aimY −1..1, charged, release (true один кадр), element|null }` — HAND
- `input.handSpell = { phase:'idle'|'form'|'hold'|'throw', element:'fire'|'storm'|'frost'|'earth', power 0..1, dir:{x,y} }` — HAND
- `input.camera = { yawRate, pitchRate, zoom }` — управление камерой телом или головой (CTRL)
- Пока `input.bow.active`, левая рука НЕ двигает героя (CTRL это уважает).

**C3. События боя** (форма `{id, type, position, data}`), новые типы:
- `bow_draw_start`, `bow_draw {draw}`, `bow_release {draw, charged, element}`, `arrow_hit {damage, element}` — HAND
- `hand_spell_form {element, power}`, `hand_spell_throw {element, power, dir}`, `hand_spell_hit {element, damage}`, `hand_spell_cancel` — HAND
- снаряды в snapshot.projectiles: kind `'arrow'` и `'hand_orb'` (+ поле element) — HAND
- `pvp_round {phase:'countdown'|'fight'|'round_end'|'match_end', round, score:[me, opp], winner}` — PVP
- `zone_enter {zoneId, name, subtitle}` — FOREST шлёт, BDO рисует титр зоны
- Каждое событие соперника, пришедшее по сети, получает `data.remote = true`: эффекты рисуют его в цвете соперника.

**C4. Snapshot** (combat.getSnapshot()):
- `snap.mode = 'boss'|'pvp'` (PVP)
- `snap.opponent = { id, name, hero, position, yaw, hp, maxHp, energy, maxEnergy, action, shielding, invulnerable, stunned, slowed } | null` (PVP заполняет из сети)
- `snap.lockTarget = { position, kind:'boss'|'player' }` — цель lock-on. Камера (CTRL) и HUD (BDO) берут цель отсюда, а не напрямую из snap.boss. Если поля нет, по умолчанию цель — босс.

**C5. Герой** (HERO, modules/heroModel.js):
- createHeroModel(...) можно вызывать несколько раз, у каждого экземпляра свой root (для удалённого игрока NET);
- `heroModel.update(dt, snapLike, events)` — от snapLike нужно только `{player:{…как в snapshot}}`;
- `heroModel.getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }` — THREE.Object3D в мире; к ним VFX и HAND крепят эффекты. У процедурного героя имена те же;
- `heroModel.setPose({ bowDraw 0..1, aim:{x,y}, handSpell 0..1 })` — поза лука или каста поверх анимаций.

**C6. Сеть** (NET, net/net.js):
- `createNet({transport:'peer'|'lan'|'local'})` → `{ host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn), close(), state ('idle'|'connecting'|'connected'|'lost'), ping, isHost }`
- Сообщения (JSON с полем t): `hello{v:'ASHEN_NET_1', name, hero}`, `st{…состояние 20 Гц}`, `ev{e}`, `hit{id, dmg, kind, fx, from, dir}`, `hitAck{id, applied, reason}`, `duel{phase, round, score, at}`, `ping`/`pong`.
- Транспорты: 'peer' — PeerJS через интернет по коду комнаты; 'lan' — WebSocket-ретранслятор tools/relay.py в локальной сети; 'local' — BroadcastChannel, две вкладки на одном ноутбуке (для тестов).

**C7. Карта** (FOREST, modules/brightForest.js — по образцу modules/elfVillage.js):
- `BRIGHT_FOREST = { id:'bright-forest', name:'Сияющий лес', x, z, r, level, duel:{ x, z, r, spawns:[{x,z,yaw},{x,z,yaw}] } }`
- `createBrightForest({THREE, scene, …})` → `{ colliders, groundAt(x,z), weight (0..1 — насколько герой внутри зоны), update(dt, heroPos), setQuality(q), dispose() }`
````

---

## Промпт №3 · [PVP] Дуэль игрок против игрока

````text
# ТВОЯ РОЛЬ: №3 [PVP] — дуэль игрок против игрока

Цель владельца: завтра двое рубятся друг с другом по сети. Сеть, лобби и отрисовку второго героя делает №2 [NET] (контракты C6, C3, C4), а ты делаешь сам бой: цель, попадания, урон, защиту, раунды и итоги. Пока net/ от №2 нет в main, сделай у себя тонкую заглушку на BroadcastChannel (две вкладки) с тем же API C6 и работай; когда модуль №2 появится, переключись на него. Первая играбельная дуэль в двух вкладках (DEBUG, клавиатура) нужна к T+2:30.

Сейчас modules/combat.js (~2300 строк) заточен под босса Регента: lock-on, снаряды, руны и печати бьют по боссу (st.b, BOSS), встреча переключает состояния engaged/explore.

Задачи:
1. **Режим `snap.mode = 'pvp'` (C4).** В combat.js — минимальные хуки с тегом [PVP], вся логика — в modules/pvp.js.
   - Босс не обновляется и не бьёт, его модель скрыта (хук в world.js с тегом [PVP]). Встреча переходит в engaged, когда соперник ближе ~35 м.
   - Каждый кадр `combat.setOpponent(state)` получает данные из remotePlayer.getState() и заполняет snap.opponent и snap.lockTarget (это цель lock-on для камеры №1 и HUD №8).
   - Всё, что пускает игрок (искра, рассечение, выброс, сфера и призма, 10 рун, печати, стрелы и заклинания рукой от №6 — kind 'arrow' и 'hand_orb'), проверяется на попадание по капсуле соперника (r ≈ 0,45, h ≈ 1,8) в его интерполированной позиции. Попадание → сообщение `hit {id, dmg, kind, fx:{stun, slow, knock, dot}, from, dir}`. Руны, которые накладывали статусы на Регента (оглушение ϟ, замедление ⧗, метка), переведи в fx для игрока с PvP-длительностями: оглушение не дольше 0,8 с, замедление не дольше 2,5 с.
   - Входящий hit применяет ЖЕРТВА через `combat.applyRemoteHit`. Учитываются её i-кадры рывка, щит (блок и расход энергии), парирование (снаряд летит назад, и hit уходит атакующему), оберег и бастион. Жертва отвечает hitAck и порождает события player_hit, block, parry, как в бою с боссом (эффекты и HUD их уже понимают). Повторы отсекаются по id.
   - Лечение и регенерация действуют только на себя; сброс откатов ℓ — с ограничением для PvP.
2. **Баланс PvP в config.pvp** (отдельно от босса): HP 400, множители урона по способностям и откаты подобраны так, чтобы бой длился 45–90 с. Ваншотов нет: одно попадание снимает не больше 18% HP. Рывок — главная защита. Напиши dev/pvp.test.mjs: 200 симулированных дуэлей ботов с разными стилями; проверь среднюю длительность и долю побед (ни один стиль не выигрывает больше 65%).
3. **Раунды** (фазами управляет хост, сообщения duel). Отсчёт «3-2-1 — БОЙ!», матч до 2 побед из 3. В конце раунда — замедление на 0,5 с и надпись «ПОБЕДА РАУНДА» или «ПОРАЖЕНИЕ». Затем респаун на точках BRIGHT_FOREST.duel.spawns (C7; если модуля №5 нет — две точки в ±12 м от центра арены): полные HP, энергия и откаты, неуязвимость 1,5 с после появления. Шли события pvp_round (C3). При обрыве сети — пауза «Соперник отключился…» на 20 с, затем техническая победа.
4. **Итог матча:** экран через хук в ui.js с тегом [PVP] или своя панель. Победитель, счёт, нанесённый и полученный урон, точность жестов, любимое заклинание; кнопки «Реванш» (подтверждают обе стороны) и «В меню».
5. **Честность при лаге.** Попадание засчитывает атакующий по интерполированной позиции (с компенсацией примерно половины RTT). Жертва может отменить его только своей защитой, активной в момент удара (буфер 150 мс). Опиши это в BUILD_STATUS.
6. Одиночный бой с боссом не должен измениться: прогони старые тесты, dev/combat.test.js и тесты босса.

Готово, когда: в двух вкладках (DEBUG) проходит матч из трёх раундов со всеми способностями; блок, парирование и рывок работают против игрока; счёт и итоги верные; dev/pvp.test.mjs проходит.

---

## ОБЩИЕ ПРАВИЛА (одинаковые у всех 8 агентов)

Проект — **ASHEN OATH**: браузерная 3D-игра в тёмном фэнтези, управление веб-камерой (руки и тело). Three.js 0.185 (importmap в index.html, без сборки, чистые ES-модули), MediaPipe Hands + Pose в Web Worker, VRM-герои (@pixiv/three-vrm). Статический сайт (GitHub Pages); локально — `python serve_game.py` → http://127.0.0.1:8765. В меню есть «Отладка с клавиатуры»: бой без камеры (WASD, Пробел, U/I/F и т. д., см. README).

Параллельно с тобой работают ещё 7 агентов, у всех 5 часов. Общая цель: к концу игра выглядит и играется как дорогая игра, максимально близко к Black Desert Online, и ЗАВТРА двое игроков дерутся по сети со своих ноутбуков.

**Старт (≤ 15 мин).** Первой командой выполни `date` и запомни это время как T0; все «T+…» ниже отсчитывай от него. Прочитай README.md, верх BUILD_STATUS.md, CANON.md, config.js, main.js и файлы своей зоны. Напиши в чат план из 5–8 пунктов и сразу начинай, подтверждения не жди.

**Git.**
- Работай в своей ветке сессии. Тебе ЯВНО РАЗРЕШЕНО вливать работу в `main`: `git fetch origin main && git merge origin/main` → тесты → проверка запуска → `git push origin HEAD:main`. Если push отклонён (кто-то успел раньше), повтори fetch, merge, проверку и push. В `main` никаких rebase и force-push.
- Вливай в main на контрольных точках T+1:15, T+2:30, T+3:45 и T+4:45. Между ними подтягивай main хотя бы раз в час, чтобы видеть чужие изменения.
- Коммиты мелкие, сообщения на русском, с тегом зоны: «[CTRL] …».
- При конфликте в общем файле сохраняй обе стороны. Чужие хуки не удаляй и не переписывай.

**Владение файлами (главное правило против конфликтов).**

| Тег | Агент | Свободно правит |
|---|---|---|
| [CTRL] | №1 Управление | core/steerStick.js, core/leftStick.js, core/cameraRig.js, core/debugInput.js, новые core/headLook.js, core/ctrl*.js |
| [NET] | №2 Сеть | новая папка net/, modules/netLobby.js, modules/netLobby.css, modules/remotePlayer.js, tools/relay.py |
| [PVP] | №3 Дуэль | новый modules/pvp.js, новые dev/pvp*.test.mjs |
| [HERO] | №4 Герои | modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/, assets/quaternius/, новые assets/heroes/, modules/heroShowcase.js |
| [FOREST] | №5 Лес | новый modules/brightForest.js, новые assets/forest/ |
| [HAND] | №6 Лук и магия рукой | новые core/bowGesture.js, core/handMagic.js, core/handFxOverlay.js, modules/combatHand.js |
| [VFX] | №7 Эффекты | modules/effects.js, новые modules/fx/*.js, dev/effects_testbench.html |
| [BDO] | №8 Стиль BDO | modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js, core/postfx.js, modules/atmosphere.js |

Общие «горячие» файлы ничьи: main.js, config.js, index.html, modules/combat.js, modules/world.js, core/handGestures.js, modules/vision.js. В них допустимы только маленькие точечные вставки (хуки), и каждую нужно пометить комментарием со своим тегом, например `// [CTRL] …`. Чужой код не переформатируй, не переименовывай и не переставляй. Большую логику выноси в новый файл своей зоны и вызывай его оттуда одной строкой. Новые ключи настроек добавляй отдельным блоком в конце sanitizeSettings в main.js, со своим тегом. Если чужой файл нужно менять сильнее, сделай минимальный хук, а в BUILD_STATUS опиши, что стоит доделать владельцу.

**Надёжность.**
- Всё новое прячь за настройкой в config.defaultSettings (ключ из контракта C1) и оборачивай в try/catch с откатом к старому поведению (так уже сделаны heroModel и postfx). После каждого твоего push в main игра обязана запускаться: меню → бой (DEBUG) без ошибок в консоли.
- Существующие жесты, руны, режим «ОШИБКА», тренировки и калибровка должны работать как прежде.
- Производительность: ноутбуки слабые, а MediaPipe уже нагружает GPU. На `medium` в бою нужно ≥ 40 fps на встроенной графике. Тяжёлое включай только на `high`. Уважай settings.quality и settings.reducedMotion. Используй инстансинг и пулы, не создавай объекты с new в каждом кадре.
- Ассеты — только CC0, MIT или CC-BY (с атрибуцией), каждый запиши в ATTRIBUTION.md. Файлы больше 5 МБ добавляй, только если без них никак, и сжимай (для VRM — tools/shrink_vrm.py).

**Проверка (в облаке нет камеры).**
- node-тесты: `for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done` — все должны проходить. Для своей части добавь новые.
- Браузер: Chromium лежит в /opt/pw-browsers (`find /opt/pw-browsers -name chrome -type f`). tools/qa_browser.mjs и tools/qa_shots.mjs принимают `--browser <путь>`. Можно написать и свой скрипт на Playwright в DEBUG-режиме со скриншотами. Смотри скриншоты сам: это твои глаза.
- Жесты проверяй синтетикой и фикстурами (dev/fixtures/hands, по образцу dev/handGestures*.test.mjs).

**Контракты между агентами (ниже).** Не ломай их, расширяй только добавлением полей. Если тебе нужно что-то из чужой зоны, а в main этого ещё нет, сделай у себя заглушку и работай дальше, не жди.

**T+4:15 — заморозка фич:** дальше только исправление багов, скорость и полировка. В конце добавь раздел «V6 · <твоя зона>» в BUILD_STATUS.md (что сделано, как проверить, что не успел) и строки в README.md, если меняется то, что видит игрок.

## КОНТРАКТЫ (общие для всех)

**C1. Настройки** (config.defaultSettings; main.js sanitizeSettings должен их пропускать):
`moveMode` — режим движения, ТОЛЬКО через камеру (набор значений задаёт №1 [CTRL]; клавиатура и мышь в бою не используются) · `camSens: 1` (CTRL) · `startZone: 'arena'|'forest'` (FOREST) · `bdoUi: true` (BDO) · `heroShading: 'realistic'|'anime'` (HERO) · `netName: ''` (NET).

**C2. Ввод** (объект input из vision/debugInput; main.js дополняет его до combat.update):
- `input.bow = { active, draw 0..1, aimX −1..1, aimY −1..1, charged, release (true один кадр), element|null }` — HAND
- `input.handSpell = { phase:'idle'|'form'|'hold'|'throw', element:'fire'|'storm'|'frost'|'earth', power 0..1, dir:{x,y} }` — HAND
- `input.camera = { yawRate, pitchRate, zoom }` — управление камерой телом или головой (CTRL)
- Пока `input.bow.active`, левая рука НЕ двигает героя (CTRL это уважает).

**C3. События боя** (форма `{id, type, position, data}`), новые типы:
- `bow_draw_start`, `bow_draw {draw}`, `bow_release {draw, charged, element}`, `arrow_hit {damage, element}` — HAND
- `hand_spell_form {element, power}`, `hand_spell_throw {element, power, dir}`, `hand_spell_hit {element, damage}`, `hand_spell_cancel` — HAND
- снаряды в snapshot.projectiles: kind `'arrow'` и `'hand_orb'` (+ поле element) — HAND
- `pvp_round {phase:'countdown'|'fight'|'round_end'|'match_end', round, score:[me, opp], winner}` — PVP
- `zone_enter {zoneId, name, subtitle}` — FOREST шлёт, BDO рисует титр зоны
- Каждое событие соперника, пришедшее по сети, получает `data.remote = true`: эффекты рисуют его в цвете соперника.

**C4. Snapshot** (combat.getSnapshot()):
- `snap.mode = 'boss'|'pvp'` (PVP)
- `snap.opponent = { id, name, hero, position, yaw, hp, maxHp, energy, maxEnergy, action, shielding, invulnerable, stunned, slowed } | null` (PVP заполняет из сети)
- `snap.lockTarget = { position, kind:'boss'|'player' }` — цель lock-on. Камера (CTRL) и HUD (BDO) берут цель отсюда, а не напрямую из snap.boss. Если поля нет, по умолчанию цель — босс.

**C5. Герой** (HERO, modules/heroModel.js):
- createHeroModel(...) можно вызывать несколько раз, у каждого экземпляра свой root (для удалённого игрока NET);
- `heroModel.update(dt, snapLike, events)` — от snapLike нужно только `{player:{…как в snapshot}}`;
- `heroModel.getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }` — THREE.Object3D в мире; к ним VFX и HAND крепят эффекты. У процедурного героя имена те же;
- `heroModel.setPose({ bowDraw 0..1, aim:{x,y}, handSpell 0..1 })` — поза лука или каста поверх анимаций.

**C6. Сеть** (NET, net/net.js):
- `createNet({transport:'peer'|'lan'|'local'})` → `{ host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn), close(), state ('idle'|'connecting'|'connected'|'lost'), ping, isHost }`
- Сообщения (JSON с полем t): `hello{v:'ASHEN_NET_1', name, hero}`, `st{…состояние 20 Гц}`, `ev{e}`, `hit{id, dmg, kind, fx, from, dir}`, `hitAck{id, applied, reason}`, `duel{phase, round, score, at}`, `ping`/`pong`.
- Транспорты: 'peer' — PeerJS через интернет по коду комнаты; 'lan' — WebSocket-ретранслятор tools/relay.py в локальной сети; 'local' — BroadcastChannel, две вкладки на одном ноутбуке (для тестов).

**C7. Карта** (FOREST, modules/brightForest.js — по образцу modules/elfVillage.js):
- `BRIGHT_FOREST = { id:'bright-forest', name:'Сияющий лес', x, z, r, level, duel:{ x, z, r, spawns:[{x,z,yaw},{x,z,yaw}] } }`
- `createBrightForest({THREE, scene, …})` → `{ colliders, groundAt(x,z), weight (0..1 — насколько герой внутри зоны), update(dt, heroPos), setQuality(q), dispose() }`
````

---

## Промпт №4 · [HERO] Новые красивые герои без багов

````text
# ТВОЯ РОЛЬ: №4 [HERO] — новые красивые герои без багов

Владелец в ярости (дословно): «нахуя голова девушек крутится без остановки!!! ихние дизайны просто уёбищные — пусть их нахуй удалит и создаст новых персов, красивых и не забагованных». Ориентир — Black Desert Online: реалистичные пропорции, дорогая детальная броня, плащи, оружие, выразительные анимации. НЕ аниме.

Сейчас (modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/):
- «Эльфийка» (elf.vrm) и «Тёмная чародейка» (dark.vrm) — VroidHub-аниме VRM. У них крутится голова. Анимации — 6 клипов Quaternius (woman.glb), перенесённые на VRM по направлениям костей в vrmKit.retargetClip (шея и голова в режиме 'delta').
- «Пепельный страж» — процедурный герой из жёстких частей на скелете (world.js makeRig).
- Эльфы-жители деревни (modules/elfVillage.js, villager_*.vrm) тоже VRM. Их не удаляй, но проверь, нет ли у них того же бага.

Задачи по порядку:
1. **Сначала найди и почини вращение головы (первые 30–40 мин).** Это может быть общий баг переноса, и тогда он сломает и новых героев.
   - Сделай стенд dev/hero-head.test.mjs или html-стенд через Playwright: проиграй каждый клип и каждое состояние (idle, шаг, бег, назад, стрейф, каст, щит, рывок, меню) по 10 с и замерь угол головы относительно груди.
   - Норма: |yaw| ≤ 40°, |pitch| ≤ 30°, угловая скорость без бесконечного вращения.
   - Гипотезы: перенос 'delta' для neck/head в vrmKit (неверная rest-поза или мировая система координат); ход назад через отрицательный timeScale; смешивание верхнего и нижнего слоёв (дорожки ног вырезаны, а шея/голова берутся из двух клипов); VRM lookAt и spring bones; накопление поворота в heroModel (S.turn, W.rotation) или в зеркале рук; поворот к камере в меню.
   - Найди точную причину, почини в корне и опиши в BUILD_STATUS.
2. **Удали «Эльфийку» и «Тёмную чародейку»:** HEROES, файлы assets/vroid/elf.vrm и dark.vrm, их записи в ATTRIBUTION.md. Если в настройках у игрока сохранён удалённый герой, sanitizeSettings в main.js должен переводить его на героя по умолчанию.
3. **Создай 3 новых героя в духе BDO:** воин-маг (мужчина), волшебница (женщина), лучница (женщина; под лук от №6).
   - **Главное правило против багов:** модель и анимации на ОДНОМ родном скелете, без переноса клипов. Так голова и конечности не «улетают».
   - Где брать, по порядку:
     (а) CC0 Quaternius Universal Base Characters + Universal Animation Library (один скелет, реалистичные пропорции, много клипов: стрейф, назад, кувырки, каст, лук, удары, смерть). Скачай, если сеть пускает; проверь лицензию и размер;
     (б) другие CC0/CC-BY скиннинговые реалистичные модели с родными анимациями (glTF), с атрибуцией;
     (в) если сеть не пускает — напиши владельцу в чат, какие именно файлы скачать и куда положить в репозиторий, а пока работай на уже лежащих assets/quaternius/human.glb и woman.glb (у них родные клипы).
   - Внешний вид делай сам, поверх базы:
     - лицо и кожа: MeshPhysicalMaterial, мягкий фейковый подповерхностный свет — wrap-свет, тёплый оттенок, sheen;
     - волосы с анизотропным бликом;
     - доспехи и одежда процедурно или из CC0: наплечники, наручи, кираса или корсет, пояс с подсумками, плащ или накидка с ветром и инерцией, светящиеся рунные узоры, украшения;
     - оружие: посох с кристаллом, лук, клинок;
     - палитра BDO: тёмная сталь, бронза, кожа, благородные ткани (бордо, глубокий синий, слоновая кость);
     - контровой rim-свет.
   - Каждому герою — имя, класс, стихия, 3 строки описания (по-русски).
   - «Пепельного стража» замени воином-магом или доведи его до того же уровня.
4. **Анимации — не меньше 14 и родные:** idle с дыханием, шаг и бег вперёд, **ход назад, стрейф влево и вправо** (№1 делает движение во все четыре стороны — ноги не должны скользить), поворот на месте, уклон-кувырок в 4 стороны, каст одной и двумя руками, натяжение, удержание и выстрел из лука, блок, получение удара, оглушение, смерть, победа. Бленды по скорости и направлению (2D-бленд вперёд/назад/вбок); в lock-on корпус развёрнут к цели.
5. **API по контракту C5 — влей в main к T+1:15,** на него рассчитывают №2 (второй игрок по сети), №6 и №7:
   - несколько экземпляров createHeroModel без общих материалов и миксеров;
   - `getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }`;
   - `setPose({ bowDraw, aim, handSpell })`.
   Старый API `update(dt, snap, events)`, `setHero(id)`, `state()` сохрани.
6. **Экран выбора героя** в духе BDO: крупный герой в кинематографичном свете (ключевой, контровой, заполняющий), медленный облёт, стойка класса. Свет и сцена — у тебя (modules/heroShowcase.js); разметка и стиль карточек — №8 (хук с тегом или договорись через BUILD_STATUS).
7. **Производительность:** один герой не дороже 1,5 мс кадра на medium, текстуры не больше 2K, один герой не больше 8 МБ, LOD для удалённого игрока.

Готово, когда: у всех героев голова не крутится (стенд из п.1 зелёный на каждом клипе); старых VRM-героинь нет; 3 новых героя выглядят на скриншотах tools/qa_shots.mjs (меню, выбор героя, бой) заметно дороже прежних (сравнение «до/после» в TEST_REPORT.md); анимаций ≥ 14, ноги не скользят при ходе назад и вбок; C5 работает; fps упал не больше чем на 10 %.

---

## ОБЩИЕ ПРАВИЛА (одинаковые у всех 8 агентов)

Проект — **ASHEN OATH**: браузерная 3D-игра в тёмном фэнтези, управление веб-камерой (руки и тело). Three.js 0.185 (importmap в index.html, без сборки, чистые ES-модули), MediaPipe Hands + Pose в Web Worker, VRM-герои (@pixiv/three-vrm). Статический сайт (GitHub Pages); локально — `python serve_game.py` → http://127.0.0.1:8765. В меню есть «Отладка с клавиатуры»: бой без камеры (WASD, Пробел, U/I/F и т. д., см. README).

Параллельно с тобой работают ещё 7 агентов, у всех 5 часов. Общая цель: к концу игра выглядит и играется как дорогая игра, максимально близко к Black Desert Online, и ЗАВТРА двое игроков дерутся по сети со своих ноутбуков.

**Старт (≤ 15 мин).** Первой командой выполни `date` и запомни это время как T0; все «T+…» ниже отсчитывай от него. Прочитай README.md, верх BUILD_STATUS.md, CANON.md, config.js, main.js и файлы своей зоны. Напиши в чат план из 5–8 пунктов и сразу начинай, подтверждения не жди.

**Git.**
- Работай в своей ветке сессии. Тебе ЯВНО РАЗРЕШЕНО вливать работу в `main`: `git fetch origin main && git merge origin/main` → тесты → проверка запуска → `git push origin HEAD:main`. Если push отклонён (кто-то успел раньше), повтори fetch, merge, проверку и push. В `main` никаких rebase и force-push.
- Вливай в main на контрольных точках T+1:15, T+2:30, T+3:45 и T+4:45. Между ними подтягивай main хотя бы раз в час, чтобы видеть чужие изменения.
- Коммиты мелкие, сообщения на русском, с тегом зоны: «[CTRL] …».
- При конфликте в общем файле сохраняй обе стороны. Чужие хуки не удаляй и не переписывай.

**Владение файлами (главное правило против конфликтов).**

| Тег | Агент | Свободно правит |
|---|---|---|
| [CTRL] | №1 Управление | core/steerStick.js, core/leftStick.js, core/cameraRig.js, core/debugInput.js, новые core/headLook.js, core/ctrl*.js |
| [NET] | №2 Сеть | новая папка net/, modules/netLobby.js, modules/netLobby.css, modules/remotePlayer.js, tools/relay.py |
| [PVP] | №3 Дуэль | новый modules/pvp.js, новые dev/pvp*.test.mjs |
| [HERO] | №4 Герои | modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/, assets/quaternius/, новые assets/heroes/, modules/heroShowcase.js |
| [FOREST] | №5 Лес | новый modules/brightForest.js, новые assets/forest/ |
| [HAND] | №6 Лук и магия рукой | новые core/bowGesture.js, core/handMagic.js, core/handFxOverlay.js, modules/combatHand.js |
| [VFX] | №7 Эффекты | modules/effects.js, новые modules/fx/*.js, dev/effects_testbench.html |
| [BDO] | №8 Стиль BDO | modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js, core/postfx.js, modules/atmosphere.js |

Общие «горячие» файлы ничьи: main.js, config.js, index.html, modules/combat.js, modules/world.js, core/handGestures.js, modules/vision.js. В них допустимы только маленькие точечные вставки (хуки), и каждую нужно пометить комментарием со своим тегом, например `// [CTRL] …`. Чужой код не переформатируй, не переименовывай и не переставляй. Большую логику выноси в новый файл своей зоны и вызывай его оттуда одной строкой. Новые ключи настроек добавляй отдельным блоком в конце sanitizeSettings в main.js, со своим тегом. Если чужой файл нужно менять сильнее, сделай минимальный хук, а в BUILD_STATUS опиши, что стоит доделать владельцу.

**Надёжность.**
- Всё новое прячь за настройкой в config.defaultSettings (ключ из контракта C1) и оборачивай в try/catch с откатом к старому поведению (так уже сделаны heroModel и postfx). После каждого твоего push в main игра обязана запускаться: меню → бой (DEBUG) без ошибок в консоли.
- Существующие жесты, руны, режим «ОШИБКА», тренировки и калибровка должны работать как прежде.
- Производительность: ноутбуки слабые, а MediaPipe уже нагружает GPU. На `medium` в бою нужно ≥ 40 fps на встроенной графике. Тяжёлое включай только на `high`. Уважай settings.quality и settings.reducedMotion. Используй инстансинг и пулы, не создавай объекты с new в каждом кадре.
- Ассеты — только CC0, MIT или CC-BY (с атрибуцией), каждый запиши в ATTRIBUTION.md. Файлы больше 5 МБ добавляй, только если без них никак, и сжимай (для VRM — tools/shrink_vrm.py).

**Проверка (в облаке нет камеры).**
- node-тесты: `for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done` — все должны проходить. Для своей части добавь новые.
- Браузер: Chromium лежит в /opt/pw-browsers (`find /opt/pw-browsers -name chrome -type f`). tools/qa_browser.mjs и tools/qa_shots.mjs принимают `--browser <путь>`. Можно написать и свой скрипт на Playwright в DEBUG-режиме со скриншотами. Смотри скриншоты сам: это твои глаза.
- Жесты проверяй синтетикой и фикстурами (dev/fixtures/hands, по образцу dev/handGestures*.test.mjs).

**Контракты между агентами (ниже).** Не ломай их, расширяй только добавлением полей. Если тебе нужно что-то из чужой зоны, а в main этого ещё нет, сделай у себя заглушку и работай дальше, не жди.

**T+4:15 — заморозка фич:** дальше только исправление багов, скорость и полировка. В конце добавь раздел «V6 · <твоя зона>» в BUILD_STATUS.md (что сделано, как проверить, что не успел) и строки в README.md, если меняется то, что видит игрок.

## КОНТРАКТЫ (общие для всех)

**C1. Настройки** (config.defaultSettings; main.js sanitizeSettings должен их пропускать):
`moveMode` — режим движения, ТОЛЬКО через камеру (набор значений задаёт №1 [CTRL]; клавиатура и мышь в бою не используются) · `camSens: 1` (CTRL) · `startZone: 'arena'|'forest'` (FOREST) · `bdoUi: true` (BDO) · `heroShading: 'realistic'|'anime'` (HERO) · `netName: ''` (NET).

**C2. Ввод** (объект input из vision/debugInput; main.js дополняет его до combat.update):
- `input.bow = { active, draw 0..1, aimX −1..1, aimY −1..1, charged, release (true один кадр), element|null }` — HAND
- `input.handSpell = { phase:'idle'|'form'|'hold'|'throw', element:'fire'|'storm'|'frost'|'earth', power 0..1, dir:{x,y} }` — HAND
- `input.camera = { yawRate, pitchRate, zoom }` — управление камерой телом или головой (CTRL)
- Пока `input.bow.active`, левая рука НЕ двигает героя (CTRL это уважает).

**C3. События боя** (форма `{id, type, position, data}`), новые типы:
- `bow_draw_start`, `bow_draw {draw}`, `bow_release {draw, charged, element}`, `arrow_hit {damage, element}` — HAND
- `hand_spell_form {element, power}`, `hand_spell_throw {element, power, dir}`, `hand_spell_hit {element, damage}`, `hand_spell_cancel` — HAND
- снаряды в snapshot.projectiles: kind `'arrow'` и `'hand_orb'` (+ поле element) — HAND
- `pvp_round {phase:'countdown'|'fight'|'round_end'|'match_end', round, score:[me, opp], winner}` — PVP
- `zone_enter {zoneId, name, subtitle}` — FOREST шлёт, BDO рисует титр зоны
- Каждое событие соперника, пришедшее по сети, получает `data.remote = true`: эффекты рисуют его в цвете соперника.

**C4. Snapshot** (combat.getSnapshot()):
- `snap.mode = 'boss'|'pvp'` (PVP)
- `snap.opponent = { id, name, hero, position, yaw, hp, maxHp, energy, maxEnergy, action, shielding, invulnerable, stunned, slowed } | null` (PVP заполняет из сети)
- `snap.lockTarget = { position, kind:'boss'|'player' }` — цель lock-on. Камера (CTRL) и HUD (BDO) берут цель отсюда, а не напрямую из snap.boss. Если поля нет, по умолчанию цель — босс.

**C5. Герой** (HERO, modules/heroModel.js):
- createHeroModel(...) можно вызывать несколько раз, у каждого экземпляра свой root (для удалённого игрока NET);
- `heroModel.update(dt, snapLike, events)` — от snapLike нужно только `{player:{…как в snapshot}}`;
- `heroModel.getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }` — THREE.Object3D в мире; к ним VFX и HAND крепят эффекты. У процедурного героя имена те же;
- `heroModel.setPose({ bowDraw 0..1, aim:{x,y}, handSpell 0..1 })` — поза лука или каста поверх анимаций.

**C6. Сеть** (NET, net/net.js):
- `createNet({transport:'peer'|'lan'|'local'})` → `{ host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn), close(), state ('idle'|'connecting'|'connected'|'lost'), ping, isHost }`
- Сообщения (JSON с полем t): `hello{v:'ASHEN_NET_1', name, hero}`, `st{…состояние 20 Гц}`, `ev{e}`, `hit{id, dmg, kind, fx, from, dir}`, `hitAck{id, applied, reason}`, `duel{phase, round, score, at}`, `ping`/`pong`.
- Транспорты: 'peer' — PeerJS через интернет по коду комнаты; 'lan' — WebSocket-ретранслятор tools/relay.py в локальной сети; 'local' — BroadcastChannel, две вкладки на одном ноутбуке (для тестов).

**C7. Карта** (FOREST, modules/brightForest.js — по образцу modules/elfVillage.js):
- `BRIGHT_FOREST = { id:'bright-forest', name:'Сияющий лес', x, z, r, level, duel:{ x, z, r, spawns:[{x,z,yaw},{x,z,yaw}] } }`
- `createBrightForest({THREE, scene, …})` → `{ colliders, groundAt(x,z), weight (0..1 — насколько герой внутри зоны), update(dt, heroPos), setQuality(q), dispose() }`
````

---

## Промпт №5 · [FOREST] Яркая карта «Сияющий лес»

````text
# ТВОЯ РОЛЬ: №5 [FOREST] — новая яркая фэнтези-карта «Сияющий лес»

Желание владельца: «ещё одну классную карту как в фэнтези, но более яркую, лес». Ориентир — Камасильва из Black Desert (эльфийский лес): гигантские древние деревья, золотой свет сквозь кроны, бирюзовая вода, светящиеся цветы и грибы, пыльца и светлячки, водопады, эльфийские руины. Сейчас карта 500×500 м тёмная (пепел, затмение), и яркая зона там одна — эльфийская деревня. Её модуль modules/elfVillage.js — ОБРАЗЕЦ интеграции: он сам строит геометрию и отдаёт colliders, groundAt и weight, а world.js подключает его в нескольких местах.

Задачи:
1. **modules/brightForest.js по контракту C7** и подключение в world.js хуками с тегом [FOREST] по образцу elfVillage: ZONES, дорога от арены, коллайдеры, groundAt, update, setQuality, dispose. Место — свободная область карты, например север (≈ x 20, z −175, радиус 55–70). Проверь ZONES и ROADS в world.js и границы ±262; при нужде раздвинь край мира в эту сторону. **Экспорт BRIGHT_FOREST с точками поляны дуэлей (C7) влей в main к T+1:15**: на него рассчитывает №3.
2. **Содержимое** — всё инстансингом, с LOD и пресетами low/medium/high (как QV в elfVillage):
   - 6–10 гигантских древних деревьев: стволы 3–6 м в обхвате, корни-арки, под которыми можно пройти, кроны из карточек листьев с альфа-тестом и ветром в вершинном шейдере; плюс сотни обычных деревьев разной формы, кусты, папоротники;
   - трава и цветы на GPU-инстансинге, с ветром и примятием вокруг героя; цветовые пятна: бирюза, золото, маджента, белые лилии;
   - светящиеся грибы и цветы (emissive > 1, чтобы их подхватил bloom), рунные менгиры, эльфийское святилище-руина с аркой и статуей, мостики, водопад с брызгами и туманом, ручей и озеро (вода с отражением неба, каустика на дне, кувшинки);
   - частицы: пыльца в лучах, светлячки, бабочки, падающие листья; лучи света сквозь кроны (объёмные конусы или карточки);
   - звуков не добавляй: звук в игре выключен.
3. **Настроение зоны.** Пока герой в лесу (weight от 0 до 1), небо светлое и тёплое, туман бирюзово-золотой, вместо затмения солнце, пепел не падает. atmosphere.js и postfx.js принадлежат №8: либо сделай минимальный хук с тегом [FOREST] (например, `atmosphere.setZoneMood({weight, sky, fog, sun, exposure})`), либо отдай weight наружу и договорись с №8 через BUILD_STATUS. На границе зоны — плавный переход на 20–30 м.
4. **«Поляна дуэлей» в центре леса** (для PvP №3): ровный круг r ≈ 18–22 м без препятствий в центре; по краю — кольцо рунных камней и 4–6 укрытий (корни, валуны); две точки появления друг напротив друга (BRIGHT_FOREST.duel.spawns). Свет красивый с обеих сторон, камера не упирается в деревья.
5. **Место старта.** Настройка `startZone:'arena'|'forest'` — пункт меню «Место старта: Пепельное плато / Сияющий лес» (хук с тегом в ui.js или через №8). При 'forest' герой появляется у входа в лес (хук в combat/world со своим тегом). При входе в лес шли событие `zone_enter {zoneId:'bright-forest', name:'Сияющий лес', subtitle:'Земли Древа'}` — титр в стиле BDO нарисует №8. Добавь в лесу 2 угля клятвы, как в других зонах.
6. **Производительность:** зона добавляет не больше 120 draw calls и 3 мс на medium; вне зоны почти ничего не стоит (скрывай по дистанции). Сделай снимки tools/qa_shots.mjs в лесу и на поляне дуэлей (добавь ракурсы) и сам оцени, ярко ли и «дорого» ли.

Готово, когда: от арены в лес ведёт дорога; лес яркий и живой на скриншотах; поляна дуэлей готова и экспортирует точки; fps на medium в норме; старые зоны не пострадали.

---

## ОБЩИЕ ПРАВИЛА (одинаковые у всех 8 агентов)

Проект — **ASHEN OATH**: браузерная 3D-игра в тёмном фэнтези, управление веб-камерой (руки и тело). Three.js 0.185 (importmap в index.html, без сборки, чистые ES-модули), MediaPipe Hands + Pose в Web Worker, VRM-герои (@pixiv/three-vrm). Статический сайт (GitHub Pages); локально — `python serve_game.py` → http://127.0.0.1:8765. В меню есть «Отладка с клавиатуры»: бой без камеры (WASD, Пробел, U/I/F и т. д., см. README).

Параллельно с тобой работают ещё 7 агентов, у всех 5 часов. Общая цель: к концу игра выглядит и играется как дорогая игра, максимально близко к Black Desert Online, и ЗАВТРА двое игроков дерутся по сети со своих ноутбуков.

**Старт (≤ 15 мин).** Первой командой выполни `date` и запомни это время как T0; все «T+…» ниже отсчитывай от него. Прочитай README.md, верх BUILD_STATUS.md, CANON.md, config.js, main.js и файлы своей зоны. Напиши в чат план из 5–8 пунктов и сразу начинай, подтверждения не жди.

**Git.**
- Работай в своей ветке сессии. Тебе ЯВНО РАЗРЕШЕНО вливать работу в `main`: `git fetch origin main && git merge origin/main` → тесты → проверка запуска → `git push origin HEAD:main`. Если push отклонён (кто-то успел раньше), повтори fetch, merge, проверку и push. В `main` никаких rebase и force-push.
- Вливай в main на контрольных точках T+1:15, T+2:30, T+3:45 и T+4:45. Между ними подтягивай main хотя бы раз в час, чтобы видеть чужие изменения.
- Коммиты мелкие, сообщения на русском, с тегом зоны: «[CTRL] …».
- При конфликте в общем файле сохраняй обе стороны. Чужие хуки не удаляй и не переписывай.

**Владение файлами (главное правило против конфликтов).**

| Тег | Агент | Свободно правит |
|---|---|---|
| [CTRL] | №1 Управление | core/steerStick.js, core/leftStick.js, core/cameraRig.js, core/debugInput.js, новые core/headLook.js, core/ctrl*.js |
| [NET] | №2 Сеть | новая папка net/, modules/netLobby.js, modules/netLobby.css, modules/remotePlayer.js, tools/relay.py |
| [PVP] | №3 Дуэль | новый modules/pvp.js, новые dev/pvp*.test.mjs |
| [HERO] | №4 Герои | modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/, assets/quaternius/, новые assets/heroes/, modules/heroShowcase.js |
| [FOREST] | №5 Лес | новый modules/brightForest.js, новые assets/forest/ |
| [HAND] | №6 Лук и магия рукой | новые core/bowGesture.js, core/handMagic.js, core/handFxOverlay.js, modules/combatHand.js |
| [VFX] | №7 Эффекты | modules/effects.js, новые modules/fx/*.js, dev/effects_testbench.html |
| [BDO] | №8 Стиль BDO | modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js, core/postfx.js, modules/atmosphere.js |

Общие «горячие» файлы ничьи: main.js, config.js, index.html, modules/combat.js, modules/world.js, core/handGestures.js, modules/vision.js. В них допустимы только маленькие точечные вставки (хуки), и каждую нужно пометить комментарием со своим тегом, например `// [CTRL] …`. Чужой код не переформатируй, не переименовывай и не переставляй. Большую логику выноси в новый файл своей зоны и вызывай его оттуда одной строкой. Новые ключи настроек добавляй отдельным блоком в конце sanitizeSettings в main.js, со своим тегом. Если чужой файл нужно менять сильнее, сделай минимальный хук, а в BUILD_STATUS опиши, что стоит доделать владельцу.

**Надёжность.**
- Всё новое прячь за настройкой в config.defaultSettings (ключ из контракта C1) и оборачивай в try/catch с откатом к старому поведению (так уже сделаны heroModel и postfx). После каждого твоего push в main игра обязана запускаться: меню → бой (DEBUG) без ошибок в консоли.
- Существующие жесты, руны, режим «ОШИБКА», тренировки и калибровка должны работать как прежде.
- Производительность: ноутбуки слабые, а MediaPipe уже нагружает GPU. На `medium` в бою нужно ≥ 40 fps на встроенной графике. Тяжёлое включай только на `high`. Уважай settings.quality и settings.reducedMotion. Используй инстансинг и пулы, не создавай объекты с new в каждом кадре.
- Ассеты — только CC0, MIT или CC-BY (с атрибуцией), каждый запиши в ATTRIBUTION.md. Файлы больше 5 МБ добавляй, только если без них никак, и сжимай (для VRM — tools/shrink_vrm.py).

**Проверка (в облаке нет камеры).**
- node-тесты: `for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done` — все должны проходить. Для своей части добавь новые.
- Браузер: Chromium лежит в /opt/pw-browsers (`find /opt/pw-browsers -name chrome -type f`). tools/qa_browser.mjs и tools/qa_shots.mjs принимают `--browser <путь>`. Можно написать и свой скрипт на Playwright в DEBUG-режиме со скриншотами. Смотри скриншоты сам: это твои глаза.
- Жесты проверяй синтетикой и фикстурами (dev/fixtures/hands, по образцу dev/handGestures*.test.mjs).

**Контракты между агентами (ниже).** Не ломай их, расширяй только добавлением полей. Если тебе нужно что-то из чужой зоны, а в main этого ещё нет, сделай у себя заглушку и работай дальше, не жди.

**T+4:15 — заморозка фич:** дальше только исправление багов, скорость и полировка. В конце добавь раздел «V6 · <твоя зона>» в BUILD_STATUS.md (что сделано, как проверить, что не успел) и строки в README.md, если меняется то, что видит игрок.

## КОНТРАКТЫ (общие для всех)

**C1. Настройки** (config.defaultSettings; main.js sanitizeSettings должен их пропускать):
`moveMode` — режим движения, ТОЛЬКО через камеру (набор значений задаёт №1 [CTRL]; клавиатура и мышь в бою не используются) · `camSens: 1` (CTRL) · `startZone: 'arena'|'forest'` (FOREST) · `bdoUi: true` (BDO) · `heroShading: 'realistic'|'anime'` (HERO) · `netName: ''` (NET).

**C2. Ввод** (объект input из vision/debugInput; main.js дополняет его до combat.update):
- `input.bow = { active, draw 0..1, aimX −1..1, aimY −1..1, charged, release (true один кадр), element|null }` — HAND
- `input.handSpell = { phase:'idle'|'form'|'hold'|'throw', element:'fire'|'storm'|'frost'|'earth', power 0..1, dir:{x,y} }` — HAND
- `input.camera = { yawRate, pitchRate, zoom }` — управление камерой телом или головой (CTRL)
- Пока `input.bow.active`, левая рука НЕ двигает героя (CTRL это уважает).

**C3. События боя** (форма `{id, type, position, data}`), новые типы:
- `bow_draw_start`, `bow_draw {draw}`, `bow_release {draw, charged, element}`, `arrow_hit {damage, element}` — HAND
- `hand_spell_form {element, power}`, `hand_spell_throw {element, power, dir}`, `hand_spell_hit {element, damage}`, `hand_spell_cancel` — HAND
- снаряды в snapshot.projectiles: kind `'arrow'` и `'hand_orb'` (+ поле element) — HAND
- `pvp_round {phase:'countdown'|'fight'|'round_end'|'match_end', round, score:[me, opp], winner}` — PVP
- `zone_enter {zoneId, name, subtitle}` — FOREST шлёт, BDO рисует титр зоны
- Каждое событие соперника, пришедшее по сети, получает `data.remote = true`: эффекты рисуют его в цвете соперника.

**C4. Snapshot** (combat.getSnapshot()):
- `snap.mode = 'boss'|'pvp'` (PVP)
- `snap.opponent = { id, name, hero, position, yaw, hp, maxHp, energy, maxEnergy, action, shielding, invulnerable, stunned, slowed } | null` (PVP заполняет из сети)
- `snap.lockTarget = { position, kind:'boss'|'player' }` — цель lock-on. Камера (CTRL) и HUD (BDO) берут цель отсюда, а не напрямую из snap.boss. Если поля нет, по умолчанию цель — босс.

**C5. Герой** (HERO, modules/heroModel.js):
- createHeroModel(...) можно вызывать несколько раз, у каждого экземпляра свой root (для удалённого игрока NET);
- `heroModel.update(dt, snapLike, events)` — от snapLike нужно только `{player:{…как в snapshot}}`;
- `heroModel.getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }` — THREE.Object3D в мире; к ним VFX и HAND крепят эффекты. У процедурного героя имена те же;
- `heroModel.setPose({ bowDraw 0..1, aim:{x,y}, handSpell 0..1 })` — поза лука или каста поверх анимаций.

**C6. Сеть** (NET, net/net.js):
- `createNet({transport:'peer'|'lan'|'local'})` → `{ host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn), close(), state ('idle'|'connecting'|'connected'|'lost'), ping, isHost }`
- Сообщения (JSON с полем t): `hello{v:'ASHEN_NET_1', name, hero}`, `st{…состояние 20 Гц}`, `ev{e}`, `hit{id, dmg, kind, fx, from, dir}`, `hitAck{id, applied, reason}`, `duel{phase, round, score, at}`, `ping`/`pong`.
- Транспорты: 'peer' — PeerJS через интернет по коду комнаты; 'lan' — WebSocket-ретранслятор tools/relay.py в локальной сети; 'local' — BroadcastChannel, две вкладки на одном ноутбуке (для тестов).

**C7. Карта** (FOREST, modules/brightForest.js — по образцу modules/elfVillage.js):
- `BRIGHT_FOREST = { id:'bright-forest', name:'Сияющий лес', x, z, r, level, duel:{ x, z, r, spawns:[{x,z,yaw},{x,z,yaw}] } }`
- `createBrightForest({THREE, scene, …})` → `{ colliders, groundAt(x,z), weight (0..1 — насколько герой внутри зоны), update(dt, heroPos), setQuality(q), dispose() }`
````

---

## Промпт №6 · [HAND] Лук рукой и магия, которую лепишь рукой

````text
# ТВОЯ РОЛЬ: №6 [HAND] — стрельба из лука рукой и магия, которую «лепишь» рукой

Самое сильное желание владельца: «хочу через руку стрелять из лука — прям очень, и магию прям создавать рукой». Спецификация лука есть в CANON.md: «B1 Сумеречный Лук — кулак + щепоть, натяжение, выпуск» (пока не сделан). Распознавание — core/handGestures.js (21 точка кисти, формы HS_*, машины состояний; коды «ОШИБКИ» — в core/gestureCoach.js). Данные кистей даёт modules/vision.js, бой считает modules/combat.js. Визуал эффектов делает №7 [VFX] по твоим событиям C3, позы героя — №4 [HERO] (setPose и getAnchors, C5). Не жди их: сделай в своём файле простые заглушки-эффекты, потом их заменят.

1. **ЛУК** (core/bowGesture.js — чистая логика; тесты — dev/bow.test.mjs).
   - Стойка: левая рука вытянута вперёд кулаком на уровне груди или плеча (держит лук). Правая щепоть (большой и указательный) подносится к левому кулаку — стрела наложена (bow_draw_start).
   - Натяжение: правая щепоть тянется назад к правому плечу или уху. draw от 0 до 1 — по расстоянию между кистями в ширинах плеч, плюс рост или уменьшение масштаба кисти как глубина. Полное натяжение, удержанное 0,35 с, даёт charged: стрела светится.
   - Прицел: направление левого кулака относительно центра плеч даёт aimX и aimY. Мягкий аим-ассист к lockTarget в конусе 12°. Если целиться высоко вверх с полным натяжением — «Дождь стрел» по площади.
   - Выстрел: разжать щепоть → bow_release. Урон и скорость зависят от draw; быстрая серия недонатянутых выстрелов даёт слабые стрелы.
   - Руна + лук: руна, нарисованная перед натяжением (▲ огонь, ϟ молния, ^ лёд и иглы…), заряжает следующую стрелу стихией (element).
   - Режим «ОШИБКА»: коды и тексты вроде «Сожми левую руку в кулак, как будто держишь лук», «Сведи большой и указательный в щепоть у левого кулака», «Тяни правую руку назад к уху», «Отпусти стрелу — разожми пальцы».
   - Конфликты: лук включается только связкой «левый кулак вперёд + правая щепоть рядом». Пока bow.active, левая рука не рулит (C2, №1 это соблюдает), а парирование «кулак → ладонь» и щит не срабатывают. Выход из стойки — с гистерезисом 0,2 с.
2. **МАГИЯ РУКОЙ** (core/handMagic.js; тесты — dev/handMagic.test.mjs): «лепка» заклинания в ладони правой руки.
   - Раскрытая ладонь вверх — в ладони рождается сгусток (hand_spell_form). Стихия зависит от формы кисти: ладонь вверх — огонь, «когти» (растопыренные согнутые пальцы) — молния, ладонь вниз — лёд, кулак — земля.
   - Удержание и «лепка»: сжимаешь и раскрываешь пальцы, вращаешь кисть — power растёт до 1,5 с, сгусток крупнеет.
   - Бросок: резкое движение кисти к камере или в сторону → hand_spell_throw с направлением из вектора движения руки (плюс аим-ассист). Снаряд kind 'hand_orb'.
   - Двумя руками: сгусток между ладонями (сфера и призма уже есть — не сломай их) плюс стихия правой руки даёт усиленную версию.
   - Отмена — опустить руку или медленно сжать кулак.
3. **Бой.** Способности 'arrow' и 'hand_orb' — в modules/combatHand.js: урон, скорость, гравитация стрелы, пробитие, стихийные эффекты (огонь — горение, молния — цепь на одну цель, лёд — замедление, земля — отбрасывание). В combat.js подключи хуками с тегом [HAND]. Снаряды — в snapshot.projectiles (C3). Попадания работают по боссу и по сопернику в PvP: №3 берёт твои снаряды в свой hit-тест, договоритесь о полях. Откаты, энергия, комбо.
4. **«Вау» на превью камеры:** core/handFxOverlay.js поверх видео рисует на НАСТОЯЩЕЙ руке игрока огонь или молнию в ладони, натянутую тетиву между кистями, светящуюся стрелу и линию прицела (canvas 2D, аддитивное смешивание, дёшево). Вызов — хуком с тегом [HAND] в drawTracking в main.js. Трекинг-HUD принадлежит №8, не переписывай его.
5. **Герой:** `setPose({bowDraw, aim, handSpell})` (C5): лук в руках, натяжение, прицел, ладонь с огнём. Если №4 ещё не успел, сделай простую позу на процедурном герое.
6. **Обучение и DEBUG.** Карточки «Лук» и «Магия рукой» в экране обучения (хук с тегом в ui.js). DEBUG-клавиши: B — стойка лука, удержание N — натяжение, отпускание — выстрел; M — сгусток огня, отпускание — бросок.

Готово, когда: тесты на синтетике и фикстурах дают не меньше 95% верных натяжений и выстрелов и ни одного ложного лука при обычном рулении и старых жестах; старые dev/handGestures*.test.mjs проходят; в DEBUG лук и магия рукой работают против босса; события по C3 отправляются.

---

## ОБЩИЕ ПРАВИЛА (одинаковые у всех 8 агентов)

Проект — **ASHEN OATH**: браузерная 3D-игра в тёмном фэнтези, управление веб-камерой (руки и тело). Three.js 0.185 (importmap в index.html, без сборки, чистые ES-модули), MediaPipe Hands + Pose в Web Worker, VRM-герои (@pixiv/three-vrm). Статический сайт (GitHub Pages); локально — `python serve_game.py` → http://127.0.0.1:8765. В меню есть «Отладка с клавиатуры»: бой без камеры (WASD, Пробел, U/I/F и т. д., см. README).

Параллельно с тобой работают ещё 7 агентов, у всех 5 часов. Общая цель: к концу игра выглядит и играется как дорогая игра, максимально близко к Black Desert Online, и ЗАВТРА двое игроков дерутся по сети со своих ноутбуков.

**Старт (≤ 15 мин).** Первой командой выполни `date` и запомни это время как T0; все «T+…» ниже отсчитывай от него. Прочитай README.md, верх BUILD_STATUS.md, CANON.md, config.js, main.js и файлы своей зоны. Напиши в чат план из 5–8 пунктов и сразу начинай, подтверждения не жди.

**Git.**
- Работай в своей ветке сессии. Тебе ЯВНО РАЗРЕШЕНО вливать работу в `main`: `git fetch origin main && git merge origin/main` → тесты → проверка запуска → `git push origin HEAD:main`. Если push отклонён (кто-то успел раньше), повтори fetch, merge, проверку и push. В `main` никаких rebase и force-push.
- Вливай в main на контрольных точках T+1:15, T+2:30, T+3:45 и T+4:45. Между ними подтягивай main хотя бы раз в час, чтобы видеть чужие изменения.
- Коммиты мелкие, сообщения на русском, с тегом зоны: «[CTRL] …».
- При конфликте в общем файле сохраняй обе стороны. Чужие хуки не удаляй и не переписывай.

**Владение файлами (главное правило против конфликтов).**

| Тег | Агент | Свободно правит |
|---|---|---|
| [CTRL] | №1 Управление | core/steerStick.js, core/leftStick.js, core/cameraRig.js, core/debugInput.js, новые core/headLook.js, core/ctrl*.js |
| [NET] | №2 Сеть | новая папка net/, modules/netLobby.js, modules/netLobby.css, modules/remotePlayer.js, tools/relay.py |
| [PVP] | №3 Дуэль | новый modules/pvp.js, новые dev/pvp*.test.mjs |
| [HERO] | №4 Герои | modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/, assets/quaternius/, новые assets/heroes/, modules/heroShowcase.js |
| [FOREST] | №5 Лес | новый modules/brightForest.js, новые assets/forest/ |
| [HAND] | №6 Лук и магия рукой | новые core/bowGesture.js, core/handMagic.js, core/handFxOverlay.js, modules/combatHand.js |
| [VFX] | №7 Эффекты | modules/effects.js, новые modules/fx/*.js, dev/effects_testbench.html |
| [BDO] | №8 Стиль BDO | modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js, core/postfx.js, modules/atmosphere.js |

Общие «горячие» файлы ничьи: main.js, config.js, index.html, modules/combat.js, modules/world.js, core/handGestures.js, modules/vision.js. В них допустимы только маленькие точечные вставки (хуки), и каждую нужно пометить комментарием со своим тегом, например `// [CTRL] …`. Чужой код не переформатируй, не переименовывай и не переставляй. Большую логику выноси в новый файл своей зоны и вызывай его оттуда одной строкой. Новые ключи настроек добавляй отдельным блоком в конце sanitizeSettings в main.js, со своим тегом. Если чужой файл нужно менять сильнее, сделай минимальный хук, а в BUILD_STATUS опиши, что стоит доделать владельцу.

**Надёжность.**
- Всё новое прячь за настройкой в config.defaultSettings (ключ из контракта C1) и оборачивай в try/catch с откатом к старому поведению (так уже сделаны heroModel и postfx). После каждого твоего push в main игра обязана запускаться: меню → бой (DEBUG) без ошибок в консоли.
- Существующие жесты, руны, режим «ОШИБКА», тренировки и калибровка должны работать как прежде.
- Производительность: ноутбуки слабые, а MediaPipe уже нагружает GPU. На `medium` в бою нужно ≥ 40 fps на встроенной графике. Тяжёлое включай только на `high`. Уважай settings.quality и settings.reducedMotion. Используй инстансинг и пулы, не создавай объекты с new в каждом кадре.
- Ассеты — только CC0, MIT или CC-BY (с атрибуцией), каждый запиши в ATTRIBUTION.md. Файлы больше 5 МБ добавляй, только если без них никак, и сжимай (для VRM — tools/shrink_vrm.py).

**Проверка (в облаке нет камеры).**
- node-тесты: `for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done` — все должны проходить. Для своей части добавь новые.
- Браузер: Chromium лежит в /opt/pw-browsers (`find /opt/pw-browsers -name chrome -type f`). tools/qa_browser.mjs и tools/qa_shots.mjs принимают `--browser <путь>`. Можно написать и свой скрипт на Playwright в DEBUG-режиме со скриншотами. Смотри скриншоты сам: это твои глаза.
- Жесты проверяй синтетикой и фикстурами (dev/fixtures/hands, по образцу dev/handGestures*.test.mjs).

**Контракты между агентами (ниже).** Не ломай их, расширяй только добавлением полей. Если тебе нужно что-то из чужой зоны, а в main этого ещё нет, сделай у себя заглушку и работай дальше, не жди.

**T+4:15 — заморозка фич:** дальше только исправление багов, скорость и полировка. В конце добавь раздел «V6 · <твоя зона>» в BUILD_STATUS.md (что сделано, как проверить, что не успел) и строки в README.md, если меняется то, что видит игрок.

## КОНТРАКТЫ (общие для всех)

**C1. Настройки** (config.defaultSettings; main.js sanitizeSettings должен их пропускать):
`moveMode` — режим движения, ТОЛЬКО через камеру (набор значений задаёт №1 [CTRL]; клавиатура и мышь в бою не используются) · `camSens: 1` (CTRL) · `startZone: 'arena'|'forest'` (FOREST) · `bdoUi: true` (BDO) · `heroShading: 'realistic'|'anime'` (HERO) · `netName: ''` (NET).

**C2. Ввод** (объект input из vision/debugInput; main.js дополняет его до combat.update):
- `input.bow = { active, draw 0..1, aimX −1..1, aimY −1..1, charged, release (true один кадр), element|null }` — HAND
- `input.handSpell = { phase:'idle'|'form'|'hold'|'throw', element:'fire'|'storm'|'frost'|'earth', power 0..1, dir:{x,y} }` — HAND
- `input.camera = { yawRate, pitchRate, zoom }` — управление камерой телом или головой (CTRL)
- Пока `input.bow.active`, левая рука НЕ двигает героя (CTRL это уважает).

**C3. События боя** (форма `{id, type, position, data}`), новые типы:
- `bow_draw_start`, `bow_draw {draw}`, `bow_release {draw, charged, element}`, `arrow_hit {damage, element}` — HAND
- `hand_spell_form {element, power}`, `hand_spell_throw {element, power, dir}`, `hand_spell_hit {element, damage}`, `hand_spell_cancel` — HAND
- снаряды в snapshot.projectiles: kind `'arrow'` и `'hand_orb'` (+ поле element) — HAND
- `pvp_round {phase:'countdown'|'fight'|'round_end'|'match_end', round, score:[me, opp], winner}` — PVP
- `zone_enter {zoneId, name, subtitle}` — FOREST шлёт, BDO рисует титр зоны
- Каждое событие соперника, пришедшее по сети, получает `data.remote = true`: эффекты рисуют его в цвете соперника.

**C4. Snapshot** (combat.getSnapshot()):
- `snap.mode = 'boss'|'pvp'` (PVP)
- `snap.opponent = { id, name, hero, position, yaw, hp, maxHp, energy, maxEnergy, action, shielding, invulnerable, stunned, slowed } | null` (PVP заполняет из сети)
- `snap.lockTarget = { position, kind:'boss'|'player' }` — цель lock-on. Камера (CTRL) и HUD (BDO) берут цель отсюда, а не напрямую из snap.boss. Если поля нет, по умолчанию цель — босс.

**C5. Герой** (HERO, modules/heroModel.js):
- createHeroModel(...) можно вызывать несколько раз, у каждого экземпляра свой root (для удалённого игрока NET);
- `heroModel.update(dt, snapLike, events)` — от snapLike нужно только `{player:{…как в snapshot}}`;
- `heroModel.getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }` — THREE.Object3D в мире; к ним VFX и HAND крепят эффекты. У процедурного героя имена те же;
- `heroModel.setPose({ bowDraw 0..1, aim:{x,y}, handSpell 0..1 })` — поза лука или каста поверх анимаций.

**C6. Сеть** (NET, net/net.js):
- `createNet({transport:'peer'|'lan'|'local'})` → `{ host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn), close(), state ('idle'|'connecting'|'connected'|'lost'), ping, isHost }`
- Сообщения (JSON с полем t): `hello{v:'ASHEN_NET_1', name, hero}`, `st{…состояние 20 Гц}`, `ev{e}`, `hit{id, dmg, kind, fx, from, dir}`, `hitAck{id, applied, reason}`, `duel{phase, round, score, at}`, `ping`/`pong`.
- Транспорты: 'peer' — PeerJS через интернет по коду комнаты; 'lan' — WebSocket-ретранслятор tools/relay.py в локальной сети; 'local' — BroadcastChannel, две вкладки на одном ноутбуке (для тестов).

**C7. Карта** (FOREST, modules/brightForest.js — по образцу modules/elfVillage.js):
- `BRIGHT_FOREST = { id:'bright-forest', name:'Сияющий лес', x, z, r, level, duel:{ x, z, r, spawns:[{x,z,yaw},{x,z,yaw}] } }`
- `createBrightForest({THREE, scene, …})` → `{ colliders, groundAt(x,z), weight (0..1 — насколько герой внутри зоны), update(dt, heroPos), setQuality(q), dispose() }`
````

---

## Промпт №7 · [VFX] Больше магии: визуал каждой руны

````text
# ТВОЯ РОЛЬ: №7 [VFX] — больше магии: уникальный визуал каждой руны и заклинания

Желание владельца: «больше магии, больше визуала на каждую руну», и ближе к Black Desert. Это плотные многослойные эффекты: яркое HDR-ядро, ореол, искры, дым, ударная волна, искажение воздуха, магические круги с письменами. Ты владелец modules/effects.js (~4100 строк; руны — примерно строки 2950–3100: ignis, fulgur, orbis, stella, spira, lemnis, caret, vee, clepsydra, alpha) и dev/effects_testbench.html. Крупные новые куски выноси в modules/fx/*.js.

1. **Общая база** (в первый час). Пул GPU-частиц: InstancedMesh или Points со своим шейдером — мягкие частицы, аддитивное или премультиплицированное смешивание, кривые размера и цвета, турбулентность. Лента-след (trail) для снарядов. Декали на земле (ожоги, иней, трещины) с затуханием. Магический круг-глиф: процедурный шейдер с кольцами, рунами по окружности, вращением и раскрытием. Ударная волна с искажением: если №8 даст в postfx проход дисторсии — используй его, иначе подделай рефракцией или нормалями. Вспышки света — пул из 2–3 PointLight. Бюджет: всё вместе не дороже 2,5 мс на medium, не больше 6000 частиц на medium.
2. **Каждая из 10 рун** получает свою стихию и полный цикл «накопление → выпуск → полёт → удар → послесвечение», а символ руны горит в круге под героем:
   - ▲ ignis — огненное копьё: раскалённое ядро, спиральный огненный хвост, жаркое марево, взрыв с огненным кольцом и тлеющими углями;
   - ϟ fulgur — молния: ветвящиеся ломаные разряды с неба или из руки, вспышка всего экрана на один кадр, дуги по земле, оглушённый враг в искрах;
   - ○ orbis — лечение: золото-зелёные спирали вверх по герою, лепестки, круг света, мягкий свет на лице;
   - ★ stella — звездопад: разрыв неба, метеоры со следами, кратеры с раскалёнными краями;
   - @ spira — вихрь: смерч из ветра, пепла и листьев вокруг героя, с обломками;
   - ∞ lemnis — вечность: светящиеся ленты восьмёркой вокруг героя, отложенные вспышки;
   - ^ caret — иглы: кристаллы льда и света волной пробивают землю до цели;
   - V vee — жатва: призрачный серп-полумесяц рассекает воздух, фиолетовые души;
   - ⧗ clepsydra — замедление: пузырь времени с циферблатом и стрелками вокруг цели, частицы застывают, цель уходит в холодный тон;
   - ℓ alpha — сброс откатов: осколки собираются обратно, кольцо перезарядки.
   Печати (хлопок, врата, рамка, «Дельта», «Кор»), искру, рассечение, выброс, сферу и призму подтяни до того же уровня.
3. **Руки героя в магии.** Ладони светятся, при рисовании руны за пальцами тянется след: руна рисуется светящейся линией в воздухе перед героем (по данным следа руны из input и событий), а при узнавании вспыхивает и «впечатывается» в круг. Крепи эффекты к heroModel.getAnchors() (C5, №4); пока его нет — к рукам процедурного героя (world.js, hero rig).
4. **Визуал для новых механик по контракту C3.** Для №6: лук (тетива, стрела в полёте со следом, стихийные стрелы, дождь стрел, попадание) и hand_spell (огонь, молния, лёд и земля в ладони, рост, бросок, удар). Для PvP (№3): события с `data.remote=true` рисуй теми же эффектами, но в цвете соперника (например, холодный фиолетовый против тёплого янтаря). Сделай эффект появления и смерти героя. Надписи вроде «БОЙ!» — это HUD №8, не твоё.
5. **Удары и отклик.** Искры и осколки по материалу (камень, дерево, плоть); числа урона не трогай (это HUD №8). Откалибруй тряску камеры и хит-стоп по силе удара (getCameraImpulse уже есть). Бастион и щит — гексагональная сфера с преломлением и трещинами при блоке.
6. **dev/effects_testbench.html:** кнопка на каждое заклинание и счётчик мс и частиц. Сделай скриншоты каждой руны (Playwright) и сам оцени читаемость: руны должны с одного взгляда различаться силуэтом и цветом.

Готово, когда: все 10 рун и новые заклинания на скриншотах выглядят по-разному и «дорого»; reducedMotion ослабляет вспышки и тряску; на пресете low стенд держит не меньше 30 fps; старые события рисуются как раньше или лучше.

---

## ОБЩИЕ ПРАВИЛА (одинаковые у всех 8 агентов)

Проект — **ASHEN OATH**: браузерная 3D-игра в тёмном фэнтези, управление веб-камерой (руки и тело). Three.js 0.185 (importmap в index.html, без сборки, чистые ES-модули), MediaPipe Hands + Pose в Web Worker, VRM-герои (@pixiv/three-vrm). Статический сайт (GitHub Pages); локально — `python serve_game.py` → http://127.0.0.1:8765. В меню есть «Отладка с клавиатуры»: бой без камеры (WASD, Пробел, U/I/F и т. д., см. README).

Параллельно с тобой работают ещё 7 агентов, у всех 5 часов. Общая цель: к концу игра выглядит и играется как дорогая игра, максимально близко к Black Desert Online, и ЗАВТРА двое игроков дерутся по сети со своих ноутбуков.

**Старт (≤ 15 мин).** Первой командой выполни `date` и запомни это время как T0; все «T+…» ниже отсчитывай от него. Прочитай README.md, верх BUILD_STATUS.md, CANON.md, config.js, main.js и файлы своей зоны. Напиши в чат план из 5–8 пунктов и сразу начинай, подтверждения не жди.

**Git.**
- Работай в своей ветке сессии. Тебе ЯВНО РАЗРЕШЕНО вливать работу в `main`: `git fetch origin main && git merge origin/main` → тесты → проверка запуска → `git push origin HEAD:main`. Если push отклонён (кто-то успел раньше), повтори fetch, merge, проверку и push. В `main` никаких rebase и force-push.
- Вливай в main на контрольных точках T+1:15, T+2:30, T+3:45 и T+4:45. Между ними подтягивай main хотя бы раз в час, чтобы видеть чужие изменения.
- Коммиты мелкие, сообщения на русском, с тегом зоны: «[CTRL] …».
- При конфликте в общем файле сохраняй обе стороны. Чужие хуки не удаляй и не переписывай.

**Владение файлами (главное правило против конфликтов).**

| Тег | Агент | Свободно правит |
|---|---|---|
| [CTRL] | №1 Управление | core/steerStick.js, core/leftStick.js, core/cameraRig.js, core/debugInput.js, новые core/headLook.js, core/ctrl*.js |
| [NET] | №2 Сеть | новая папка net/, modules/netLobby.js, modules/netLobby.css, modules/remotePlayer.js, tools/relay.py |
| [PVP] | №3 Дуэль | новый modules/pvp.js, новые dev/pvp*.test.mjs |
| [HERO] | №4 Герои | modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/, assets/quaternius/, новые assets/heroes/, modules/heroShowcase.js |
| [FOREST] | №5 Лес | новый modules/brightForest.js, новые assets/forest/ |
| [HAND] | №6 Лук и магия рукой | новые core/bowGesture.js, core/handMagic.js, core/handFxOverlay.js, modules/combatHand.js |
| [VFX] | №7 Эффекты | modules/effects.js, новые modules/fx/*.js, dev/effects_testbench.html |
| [BDO] | №8 Стиль BDO | modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js, core/postfx.js, modules/atmosphere.js |

Общие «горячие» файлы ничьи: main.js, config.js, index.html, modules/combat.js, modules/world.js, core/handGestures.js, modules/vision.js. В них допустимы только маленькие точечные вставки (хуки), и каждую нужно пометить комментарием со своим тегом, например `// [CTRL] …`. Чужой код не переформатируй, не переименовывай и не переставляй. Большую логику выноси в новый файл своей зоны и вызывай его оттуда одной строкой. Новые ключи настроек добавляй отдельным блоком в конце sanitizeSettings в main.js, со своим тегом. Если чужой файл нужно менять сильнее, сделай минимальный хук, а в BUILD_STATUS опиши, что стоит доделать владельцу.

**Надёжность.**
- Всё новое прячь за настройкой в config.defaultSettings (ключ из контракта C1) и оборачивай в try/catch с откатом к старому поведению (так уже сделаны heroModel и postfx). После каждого твоего push в main игра обязана запускаться: меню → бой (DEBUG) без ошибок в консоли.
- Существующие жесты, руны, режим «ОШИБКА», тренировки и калибровка должны работать как прежде.
- Производительность: ноутбуки слабые, а MediaPipe уже нагружает GPU. На `medium` в бою нужно ≥ 40 fps на встроенной графике. Тяжёлое включай только на `high`. Уважай settings.quality и settings.reducedMotion. Используй инстансинг и пулы, не создавай объекты с new в каждом кадре.
- Ассеты — только CC0, MIT или CC-BY (с атрибуцией), каждый запиши в ATTRIBUTION.md. Файлы больше 5 МБ добавляй, только если без них никак, и сжимай (для VRM — tools/shrink_vrm.py).

**Проверка (в облаке нет камеры).**
- node-тесты: `for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done` — все должны проходить. Для своей части добавь новые.
- Браузер: Chromium лежит в /opt/pw-browsers (`find /opt/pw-browsers -name chrome -type f`). tools/qa_browser.mjs и tools/qa_shots.mjs принимают `--browser <путь>`. Можно написать и свой скрипт на Playwright в DEBUG-режиме со скриншотами. Смотри скриншоты сам: это твои глаза.
- Жесты проверяй синтетикой и фикстурами (dev/fixtures/hands, по образцу dev/handGestures*.test.mjs).

**Контракты между агентами (ниже).** Не ломай их, расширяй только добавлением полей. Если тебе нужно что-то из чужой зоны, а в main этого ещё нет, сделай у себя заглушку и работай дальше, не жди.

**T+4:15 — заморозка фич:** дальше только исправление багов, скорость и полировка. В конце добавь раздел «V6 · <твоя зона>» в BUILD_STATUS.md (что сделано, как проверить, что не успел) и строки в README.md, если меняется то, что видит игрок.

## КОНТРАКТЫ (общие для всех)

**C1. Настройки** (config.defaultSettings; main.js sanitizeSettings должен их пропускать):
`moveMode` — режим движения, ТОЛЬКО через камеру (набор значений задаёт №1 [CTRL]; клавиатура и мышь в бою не используются) · `camSens: 1` (CTRL) · `startZone: 'arena'|'forest'` (FOREST) · `bdoUi: true` (BDO) · `heroShading: 'realistic'|'anime'` (HERO) · `netName: ''` (NET).

**C2. Ввод** (объект input из vision/debugInput; main.js дополняет его до combat.update):
- `input.bow = { active, draw 0..1, aimX −1..1, aimY −1..1, charged, release (true один кадр), element|null }` — HAND
- `input.handSpell = { phase:'idle'|'form'|'hold'|'throw', element:'fire'|'storm'|'frost'|'earth', power 0..1, dir:{x,y} }` — HAND
- `input.camera = { yawRate, pitchRate, zoom }` — управление камерой телом или головой (CTRL)
- Пока `input.bow.active`, левая рука НЕ двигает героя (CTRL это уважает).

**C3. События боя** (форма `{id, type, position, data}`), новые типы:
- `bow_draw_start`, `bow_draw {draw}`, `bow_release {draw, charged, element}`, `arrow_hit {damage, element}` — HAND
- `hand_spell_form {element, power}`, `hand_spell_throw {element, power, dir}`, `hand_spell_hit {element, damage}`, `hand_spell_cancel` — HAND
- снаряды в snapshot.projectiles: kind `'arrow'` и `'hand_orb'` (+ поле element) — HAND
- `pvp_round {phase:'countdown'|'fight'|'round_end'|'match_end', round, score:[me, opp], winner}` — PVP
- `zone_enter {zoneId, name, subtitle}` — FOREST шлёт, BDO рисует титр зоны
- Каждое событие соперника, пришедшее по сети, получает `data.remote = true`: эффекты рисуют его в цвете соперника.

**C4. Snapshot** (combat.getSnapshot()):
- `snap.mode = 'boss'|'pvp'` (PVP)
- `snap.opponent = { id, name, hero, position, yaw, hp, maxHp, energy, maxEnergy, action, shielding, invulnerable, stunned, slowed } | null` (PVP заполняет из сети)
- `snap.lockTarget = { position, kind:'boss'|'player' }` — цель lock-on. Камера (CTRL) и HUD (BDO) берут цель отсюда, а не напрямую из snap.boss. Если поля нет, по умолчанию цель — босс.

**C5. Герой** (HERO, modules/heroModel.js):
- createHeroModel(...) можно вызывать несколько раз, у каждого экземпляра свой root (для удалённого игрока NET);
- `heroModel.update(dt, snapLike, events)` — от snapLike нужно только `{player:{…как в snapshot}}`;
- `heroModel.getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }` — THREE.Object3D в мире; к ним VFX и HAND крепят эффекты. У процедурного героя имена те же;
- `heroModel.setPose({ bowDraw 0..1, aim:{x,y}, handSpell 0..1 })` — поза лука или каста поверх анимаций.

**C6. Сеть** (NET, net/net.js):
- `createNet({transport:'peer'|'lan'|'local'})` → `{ host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn), close(), state ('idle'|'connecting'|'connected'|'lost'), ping, isHost }`
- Сообщения (JSON с полем t): `hello{v:'ASHEN_NET_1', name, hero}`, `st{…состояние 20 Гц}`, `ev{e}`, `hit{id, dmg, kind, fx, from, dir}`, `hitAck{id, applied, reason}`, `duel{phase, round, score, at}`, `ping`/`pong`.
- Транспорты: 'peer' — PeerJS через интернет по коду комнаты; 'lan' — WebSocket-ретранслятор tools/relay.py в локальной сети; 'local' — BroadcastChannel, две вкладки на одном ноутбуке (для тестов).

**C7. Карта** (FOREST, modules/brightForest.js — по образцу modules/elfVillage.js):
- `BRIGHT_FOREST = { id:'bright-forest', name:'Сияющий лес', x, z, r, level, duel:{ x, z, r, spawns:[{x,z,yaw},{x,z,yaw}] } }`
- `createBrightForest({THREE, scene, …})` → `{ colliders, groundAt(x,z), weight (0..1 — насколько герой внутри зоны), update(dt, heroPos), setQuality(q), dispose() }`
````

---

## Промпт №8 · [BDO] Дизайн интерфейса и картинки в стиле Black Desert

````text
# ТВОЯ РОЛЬ: №8 [BDO] — дизайн интерфейса и картинки в стиле Black Desert

Жалоба владельца: «не сильно нравится дизайн, хочу больше детализации, хоть чуть-чуть приблизить к Black Desert». Ты владелец modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js (стиль превью камеры), core/postfx.js и modules/atmosphere.js. ВАЖНО: другие агенты вставляют в ui.js и battleHud.js маленькие хуки. Поэтому не переписывай эти файлы целиком: меняй разметку экранов точечно, сохраняй имена функций, экспорты и id, а основной вид делай через CSS.

Черты BDO, к которым идём:
- тёмные полупрозрачные панели с тонкой золотой или бронзовой каймой и орнаментом в углах;
- шрифты с засечками, капитель (Cinzel, Marcellus или Cormorant через Google Fonts, плюс системный запасной: игра должна работать и без шрифта);
- минималистичный боевой HUD: внизу по центру панель умений с квадратными иконками и круговыми откатами, красная полоса HP и синяя MP по бокам или над панелью, выносливость;
- вверху по центру — рамка цели: имя, уровень опасности, многослойная полоса HP с «догоняющим» слоем;
- справа сверху — мини-карта с названием зоны и координатами;
- крупный титр при входе в зону: название с засечками, тонкие линии, плавное появление и исчезание (событие zone_enter, C3);
- стильные цифры урона и уведомления справа;
- главное меню как экран входа в BDO: логотип, лёгкие частицы или пыльца, герой справа в кинематографичном свете;
- выбор героя с крупным героем и карточкой (имя, класс, описание): сцену и свет делает №4, разметку и стиль — ты;
- экран загрузки с подсказками.

Задачи:
1. **Дизайн-система в ui.css.** CSS-переменные для цветов (уголь, бронза, золото, слоновая кость, кровь, мана), рамки и уголки орнамента (inline SVG или border-image), кнопки (обычная, главная, опасная), слайдеры, переключатели, карточки, тултипы, анимации появления. Примени её ко ВСЕМ экранам ui.js: меню, выбор героя, настройки, камера, калибровка, обучение, пауза, итоги, «Клятва героя», тренировка. Настройка `bdoUi:true`; при false остаётся старый вид.
2. **Боевой HUD (battleHud.js) в стиле BDO.** Панель умений: SVG-иконки для каждой способности и 10 рун (нарисуй сам, в едином стиле), откаты из snapshot.cooldowns. Полосы HP и MP, комбо. Рамка цели по snap.lockTarget и snap.opponent (C4): в PvP показывай соперника — имя, героя, HP. Мини-карта: схема мира из layout — дороги, зоны, угли, соперник. Титр зоны, выноски урона. Индикатор движения левой руки внизу должен продолжать работать — только перерисуй его в стиле (логика — №1 [CTRL]). Карточку «ОШИБКА» оформи в стиле, но оставь такой же заметной.
3. **Превью камеры (trackingHud.js)** оформи как «гадательное зеркало»: круглая или овальная рама с орнаментом, обесцвеченное видео, руки-жилы (см. CANON, M1). Данные трекинга и оверлей №6 (handFxOverlay рисует поверх) должны работать как прежде.
4. **Картинка (postfx.js, atmosphere.js).** Кинематографичный тонмаппинг (AgX или ACES) и цветокоррекция по зонам (LUT или кривые: тёплые света и бирюзовые тени, как в BDO). Мягкий bloom только выше 1.0, виньетка, лёгкая хроматическая аберрация на мощных ударах, резкость и сглаживание (FXAA или SMAA). На high — SSAO/GTAO, если позволяет fps, и DOF в меню и на экране выбора героя. Хук настроения зоны для №5: `atmosphere.setZoneMood({weight, sky, fog, sun, exposure})` — плавная смена неба, тумана и экспозиции при входе в «Сияющий лес» (C7); сделай его в первый час. Если недорого, добавь проход дисторсии для ударных волн №7.
5. **Чужие элементы интерфейса** — «Онлайн-дуэль» №2, режим движения и камера №1, место старта №5, карточки обучения лука и магии №6, итоги PvP №3. Они вставят минимальные хуки с тегами; ты приведи их к единому стилю. Экран лобби №2 (modules/netLobby.css) оформи в той же системе.
6. **Проверка.** Снимки tools/qa_shots.mjs и свои Playwright-скриншоты каждого экрана в 1366×768, 1920×1080 и 1366×650 (на низком экране меню должно помещаться, см. коммит fce2b12). Сравнение «до/после» — в TEST_REPORT.md. HUD не должен закрывать героя и цель.

Готово, когда: все экраны и HUD в едином стиле BDO, выглядят детально и дорого на скриншотах, читаются на 1366×650; fps боя на medium упал не больше чем на 5%.

---

## ОБЩИЕ ПРАВИЛА (одинаковые у всех 8 агентов)

Проект — **ASHEN OATH**: браузерная 3D-игра в тёмном фэнтези, управление веб-камерой (руки и тело). Three.js 0.185 (importmap в index.html, без сборки, чистые ES-модули), MediaPipe Hands + Pose в Web Worker, VRM-герои (@pixiv/three-vrm). Статический сайт (GitHub Pages); локально — `python serve_game.py` → http://127.0.0.1:8765. В меню есть «Отладка с клавиатуры»: бой без камеры (WASD, Пробел, U/I/F и т. д., см. README).

Параллельно с тобой работают ещё 7 агентов, у всех 5 часов. Общая цель: к концу игра выглядит и играется как дорогая игра, максимально близко к Black Desert Online, и ЗАВТРА двое игроков дерутся по сети со своих ноутбуков.

**Старт (≤ 15 мин).** Первой командой выполни `date` и запомни это время как T0; все «T+…» ниже отсчитывай от него. Прочитай README.md, верх BUILD_STATUS.md, CANON.md, config.js, main.js и файлы своей зоны. Напиши в чат план из 5–8 пунктов и сразу начинай, подтверждения не жди.

**Git.**
- Работай в своей ветке сессии. Тебе ЯВНО РАЗРЕШЕНО вливать работу в `main`: `git fetch origin main && git merge origin/main` → тесты → проверка запуска → `git push origin HEAD:main`. Если push отклонён (кто-то успел раньше), повтори fetch, merge, проверку и push. В `main` никаких rebase и force-push.
- Вливай в main на контрольных точках T+1:15, T+2:30, T+3:45 и T+4:45. Между ними подтягивай main хотя бы раз в час, чтобы видеть чужие изменения.
- Коммиты мелкие, сообщения на русском, с тегом зоны: «[CTRL] …».
- При конфликте в общем файле сохраняй обе стороны. Чужие хуки не удаляй и не переписывай.

**Владение файлами (главное правило против конфликтов).**

| Тег | Агент | Свободно правит |
|---|---|---|
| [CTRL] | №1 Управление | core/steerStick.js, core/leftStick.js, core/cameraRig.js, core/debugInput.js, новые core/headLook.js, core/ctrl*.js |
| [NET] | №2 Сеть | новая папка net/, modules/netLobby.js, modules/netLobby.css, modules/remotePlayer.js, tools/relay.py |
| [PVP] | №3 Дуэль | новый modules/pvp.js, новые dev/pvp*.test.mjs |
| [HERO] | №4 Герои | modules/heroModel.js, modules/vrmKit.js, modules/characterLooks.js, assets/vroid/, assets/quaternius/, новые assets/heroes/, modules/heroShowcase.js |
| [FOREST] | №5 Лес | новый modules/brightForest.js, новые assets/forest/ |
| [HAND] | №6 Лук и магия рукой | новые core/bowGesture.js, core/handMagic.js, core/handFxOverlay.js, modules/combatHand.js |
| [VFX] | №7 Эффекты | modules/effects.js, новые modules/fx/*.js, dev/effects_testbench.html |
| [BDO] | №8 Стиль BDO | modules/ui.js, modules/ui.css, styles.css, core/battleHud.js, core/trackingHud.js, core/postfx.js, modules/atmosphere.js |

Общие «горячие» файлы ничьи: main.js, config.js, index.html, modules/combat.js, modules/world.js, core/handGestures.js, modules/vision.js. В них допустимы только маленькие точечные вставки (хуки), и каждую нужно пометить комментарием со своим тегом, например `// [CTRL] …`. Чужой код не переформатируй, не переименовывай и не переставляй. Большую логику выноси в новый файл своей зоны и вызывай его оттуда одной строкой. Новые ключи настроек добавляй отдельным блоком в конце sanitizeSettings в main.js, со своим тегом. Если чужой файл нужно менять сильнее, сделай минимальный хук, а в BUILD_STATUS опиши, что стоит доделать владельцу.

**Надёжность.**
- Всё новое прячь за настройкой в config.defaultSettings (ключ из контракта C1) и оборачивай в try/catch с откатом к старому поведению (так уже сделаны heroModel и postfx). После каждого твоего push в main игра обязана запускаться: меню → бой (DEBUG) без ошибок в консоли.
- Существующие жесты, руны, режим «ОШИБКА», тренировки и калибровка должны работать как прежде.
- Производительность: ноутбуки слабые, а MediaPipe уже нагружает GPU. На `medium` в бою нужно ≥ 40 fps на встроенной графике. Тяжёлое включай только на `high`. Уважай settings.quality и settings.reducedMotion. Используй инстансинг и пулы, не создавай объекты с new в каждом кадре.
- Ассеты — только CC0, MIT или CC-BY (с атрибуцией), каждый запиши в ATTRIBUTION.md. Файлы больше 5 МБ добавляй, только если без них никак, и сжимай (для VRM — tools/shrink_vrm.py).

**Проверка (в облаке нет камеры).**
- node-тесты: `for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done` — все должны проходить. Для своей части добавь новые.
- Браузер: Chromium лежит в /opt/pw-browsers (`find /opt/pw-browsers -name chrome -type f`). tools/qa_browser.mjs и tools/qa_shots.mjs принимают `--browser <путь>`. Можно написать и свой скрипт на Playwright в DEBUG-режиме со скриншотами. Смотри скриншоты сам: это твои глаза.
- Жесты проверяй синтетикой и фикстурами (dev/fixtures/hands, по образцу dev/handGestures*.test.mjs).

**Контракты между агентами (ниже).** Не ломай их, расширяй только добавлением полей. Если тебе нужно что-то из чужой зоны, а в main этого ещё нет, сделай у себя заглушку и работай дальше, не жди.

**T+4:15 — заморозка фич:** дальше только исправление багов, скорость и полировка. В конце добавь раздел «V6 · <твоя зона>» в BUILD_STATUS.md (что сделано, как проверить, что не успел) и строки в README.md, если меняется то, что видит игрок.

## КОНТРАКТЫ (общие для всех)

**C1. Настройки** (config.defaultSettings; main.js sanitizeSettings должен их пропускать):
`moveMode` — режим движения, ТОЛЬКО через камеру (набор значений задаёт №1 [CTRL]; клавиатура и мышь в бою не используются) · `camSens: 1` (CTRL) · `startZone: 'arena'|'forest'` (FOREST) · `bdoUi: true` (BDO) · `heroShading: 'realistic'|'anime'` (HERO) · `netName: ''` (NET).

**C2. Ввод** (объект input из vision/debugInput; main.js дополняет его до combat.update):
- `input.bow = { active, draw 0..1, aimX −1..1, aimY −1..1, charged, release (true один кадр), element|null }` — HAND
- `input.handSpell = { phase:'idle'|'form'|'hold'|'throw', element:'fire'|'storm'|'frost'|'earth', power 0..1, dir:{x,y} }` — HAND
- `input.camera = { yawRate, pitchRate, zoom }` — управление камерой телом или головой (CTRL)
- Пока `input.bow.active`, левая рука НЕ двигает героя (CTRL это уважает).

**C3. События боя** (форма `{id, type, position, data}`), новые типы:
- `bow_draw_start`, `bow_draw {draw}`, `bow_release {draw, charged, element}`, `arrow_hit {damage, element}` — HAND
- `hand_spell_form {element, power}`, `hand_spell_throw {element, power, dir}`, `hand_spell_hit {element, damage}`, `hand_spell_cancel` — HAND
- снаряды в snapshot.projectiles: kind `'arrow'` и `'hand_orb'` (+ поле element) — HAND
- `pvp_round {phase:'countdown'|'fight'|'round_end'|'match_end', round, score:[me, opp], winner}` — PVP
- `zone_enter {zoneId, name, subtitle}` — FOREST шлёт, BDO рисует титр зоны
- Каждое событие соперника, пришедшее по сети, получает `data.remote = true`: эффекты рисуют его в цвете соперника.

**C4. Snapshot** (combat.getSnapshot()):
- `snap.mode = 'boss'|'pvp'` (PVP)
- `snap.opponent = { id, name, hero, position, yaw, hp, maxHp, energy, maxEnergy, action, shielding, invulnerable, stunned, slowed } | null` (PVP заполняет из сети)
- `snap.lockTarget = { position, kind:'boss'|'player' }` — цель lock-on. Камера (CTRL) и HUD (BDO) берут цель отсюда, а не напрямую из snap.boss. Если поля нет, по умолчанию цель — босс.

**C5. Герой** (HERO, modules/heroModel.js):
- createHeroModel(...) можно вызывать несколько раз, у каждого экземпляра свой root (для удалённого игрока NET);
- `heroModel.update(dt, snapLike, events)` — от snapLike нужно только `{player:{…как в snapshot}}`;
- `heroModel.getAnchors()` → `{ handL, handR, chest, head, bowSocket, staffTip }` — THREE.Object3D в мире; к ним VFX и HAND крепят эффекты. У процедурного героя имена те же;
- `heroModel.setPose({ bowDraw 0..1, aim:{x,y}, handSpell 0..1 })` — поза лука или каста поверх анимаций.

**C6. Сеть** (NET, net/net.js):
- `createNet({transport:'peer'|'lan'|'local'})` → `{ host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn), close(), state ('idle'|'connecting'|'connected'|'lost'), ping, isHost }`
- Сообщения (JSON с полем t): `hello{v:'ASHEN_NET_1', name, hero}`, `st{…состояние 20 Гц}`, `ev{e}`, `hit{id, dmg, kind, fx, from, dir}`, `hitAck{id, applied, reason}`, `duel{phase, round, score, at}`, `ping`/`pong`.
- Транспорты: 'peer' — PeerJS через интернет по коду комнаты; 'lan' — WebSocket-ретранслятор tools/relay.py в локальной сети; 'local' — BroadcastChannel, две вкладки на одном ноутбуке (для тестов).

**C7. Карта** (FOREST, modules/brightForest.js — по образцу modules/elfVillage.js):
- `BRIGHT_FOREST = { id:'bright-forest', name:'Сияющий лес', x, z, r, level, duel:{ x, z, r, spawns:[{x,z,yaw},{x,z,yaw}] } }`
- `createBrightForest({THREE, scene, …})` → `{ colliders, groundAt(x,z), weight (0..1 — насколько герой внутри зоны), update(dt, heroPos), setQuality(q), dispose() }`
````

---

## Промпт №9 · ИНТЕГРАТОР (бонус, на последний час)

````text
# ТВОЯ РОЛЬ: №9 ИНТЕГРАТОР — последний час (T+4:00 … T+5:00)

Семь-восемь агентов параллельно вливали в main управление, онлайн-дуэль, героев, лес, лук и магию рукой, эффекты и интерфейс в стиле BDO. Твоя задача — чтобы к концу часа main был целым, быстрым и готовым к завтрашней игре по сети. Новых фич не делай. Правки — минимальные, с тегом [FIX].

1. `git fetch origin main`, работай от свежего main. Прогони все node-тесты (`for f in dev/*.test.mjs; do node $f >/dev/null || echo FAIL $f; done`) и браузерные (tools/qa_browser.mjs и tools/qa_shots.mjs с `--browser` из /opt/pw-browsers).
2. Пройди в headless-браузере (DEBUG): меню → выбор каждого героя → бой с боссом → победа или поражение → меню; старт в «Сияющем лесу»; все настройки; онлайн-дуэль в двух вкладках (транспорт 'local') — матч из трёх раундов. В консоли не должно быть ошибок; если есть — чини.
3. Проверь следы плохих мержей: дубли хуков, потерянные чужие хуки, конфликтующие ключи в config.defaultSettings и sanitizeSettings, два обработчика на одну клавишу, два разных смысла у одного события.
4. Скорость: `window.__ASHEN__.renderInfo()` в бою, в лесу и в PvP — draw calls, треугольники, программы. Если medium стал заметно тяжелее, чем до V6, урежь самое дорогое на medium и low (оставь на high).
5. README.md: раздел «Что нового в V6» и проверенная пошаговая инструкция «Играть вдвоём по сети» (интернет по коду комнаты и LAN). BUILD_STATUS.md: сводка V6 по всем зонам.
6. Влей в main, убедись, что GitHub Pages обновился, открой опубликованную версию и проверь, что она запускается.
````
