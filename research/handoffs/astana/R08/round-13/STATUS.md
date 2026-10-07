# R08 · раунд 13 · Астана — обученная модель: честная оценка и надёжное подключение

Статус: PARTIAL (checkpoint 3: challenge-запуск и интеграция с настоящим R06)

## Источник и BASE_MISMATCH
- Продолжаю поставку R08 раунда 12: `claude/wizardly-ptolemy-qy8ltw` HEAD 9660885, код e311ba8
  (модуль logreg + признаки словаря, корпус synthetic_v2). Прочитаны её STATUS/EXPERIMENT_LOG/EVAL_REPORT/
  FAILURES/INTEGRATION.
- Среда этой сессии — репозиторий ADMIT_STUTU, ветка `claude/eager-hawking-4up40k` (remote не менялся).
  Изолированная сборка: worktree GOV_DIPLOME на REFERENCE_BASE_SHA 56538a3 + пути R08 из e311ba8
  (коммит fb1a0bc, без изменений) + работа раунда 13. Пути R08 зеркалятся в эту ветку; патчи:
  research/round-13-results/R08/r08-round13-full.patch (git am на 56538a3) и r08-round13-delta.patch.
- В ветке ml/civic_classifier/ и tests/civic/R08/ заменены на линию раунда 12/13; прежний модуль раунда 11
  этой сессии остаётся в истории (fa356f6) и в research/round-11-results/R08/.

## Checkpoint 1 (DONE)
- Воспроизведение без сети: корпус f4464341…, split, model.json.gz и model_alt_nb.json.gz пересобраны
  побайтно идентично (python -m ml.civic_classifier audit).
- Утечки: точных дублей между splits 0; но 552 из 631 сообщений test (87 %) — из «семейств», которые есть
  в train, 534 из них — через перевод (RU/KK/смешанный). Split по шаблону переоценивает обобщение.
- Круговая лексика: 85 % сообщений корпуса содержат основу словаря эвристики своей метки
  (пробный набор — 77 %). Основы STEMS не менялись после первого коммита a26e598 (до корпуса и test).
- Гибридная архитектура выбрана после первого просмотра test (журнал раунда 12): test = exploratory.

## Checkpoint 2 (DONE)
- PROTOCOL.md и challenge_r13_v1 (134, sha256 b25a6a19…) зафиксированы и запушены (622dabf) ДО запусков.
- Leave-family-out CV (5 фолдов, 56 групп, гиперпараметры раунда 12 без подстройки), macro-F1 по фолдам:
  keyword 0.861 (0.816–0.924) · hybrid 0.856 (0.796–0.901) · logreg 0.738 · nb 0.581.
  hybrid − keyword: −0.005, лучше в 2 из 5 фолдов → превосходство гибрида НЕ подтверждено;
  чистая обученная модель хуже словаря во всех фолдах.
- Уверенные ошибки (score ≥ 0.9): hybrid 96, keyword (≥2 совпадения) 52; hybrid+abstain: покрытие 0.84,
  точность принятых 0.910, уверенных ошибок 59, безопасный исход 0.924.
- test раунда 12 (exploratory, утечка через семейства): hybrid 0.871 > keyword 0.848 — эффект split.
- classify(): отказ (multi_topic / latin_script / low_margin M=0.25 по validation / no_content) и объяснение
  (основы словаря + «начала слов» с наибольшим вкладом); поля контракта не изменены. Тесты R08: 28 passed, 1 skipped.

## Checkpoint 3 (DONE)
- Challenge_r13_v1 запущен ОДИН раз (sha256 сверен): keyword acc 0.679 / mF1 0.679; hybrid 0.724 / 0.736;
  logreg 0.612; nb 0.612; hybrid+abstain покрытие 0.649, точность принятых 0.862, уверенных ошибок 10
  (hybrid без отказа 16), безопасный исход 0.918. Слабые места у всех: адресные ловушки 0.4, отрицание
  0.36–0.45, транслит 0.17 (отказ по латинице). Уверенные ошибки гибрида совпадают с ошибками словаря
  («недорого» ⊃ «дорог», «живу возле остановки…»). После просмотра набор — exploratory.
- Настоящий R06: база 56538a3 — R08 тесты 7 passed (+1 skip r08_status); поставка R06 r12 e0b4741 +
  R08 — tests/civic/R06+R08 199 passed, 1 skipped; r08_status(настоящий R08) available.
- Отказ доходит до очереди редактора как score=null, score_kind="abstain:multi_topic"; поля abstain/
  explanation текущий R06 отбрасывает → предложен патч r06-service-r08-fields (проверен: 199 passed).
- В приложении R01 модель выключена (classifier=None). Предложен opt-in CIVIC_R08_CLASSIFIER=1;
  сквозная проверка через app.py: с флагом ok/lighting, без флага unavailable, 201 в обоих случаях.

## Следующий шаг
Отчёт эксперимента, model card, протокол двойной разметки, RUN/INTEGRATION/DELIVERY.
