# R08 · раунд 13 · Астана — обученная модель: честная оценка и надёжное подключение

Статус: PARTIAL (checkpoint 1: воспроизведение и аудит splits)

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

## Следующий шаг
Честный протокол: leave-family-out CV для эвристики, чистой logreg, гибрида (гиперпараметры раунда 12 без
перенастройки); затем отказ/объяснение и замороженный challenge-набор.
