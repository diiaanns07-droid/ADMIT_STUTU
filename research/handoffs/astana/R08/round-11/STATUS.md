# R08 — Обучаемая модель обращений · раунд 11 · Астана

Статус: PARTIAL (checkpoint 2: + 39 тестов PASS)

## Идентификация
- Роль: R08 (обучаемая модель обращений и эксперимент диплома)
- Репозиторий сессии: https://github.com/diiaanns07-droid/ADMIT_STUTU
  ВНИМАНИЕ: среда Claude Code выдала рабочую копию ADMIT_STUTU, а не ожидаемый GOV_DIPLOME.
  Remote не менялся (по правилам). Пакет раунда прочитан из GOV_DIPLOME (публичный, только чтение).
  R01 должен импортировать пути R08 из ADMIT_STUTU, ветка ниже (история веток не связана с GOV_DIPLOME,
  поэтому импорт — копированием перечисленных путей, не merge).
- Ветка: claude/eager-hawking-4up40k
- Исходный HEAD ветки: c698f7f0 (ADMIT_STUTU main, к задаче не относится)
- PACK_SHA: 9c2f5c0dae14b46c0697a9dfc7f854351bfd570d (GOV_DIPLOME origin/codex/govtech-main-interface)

## Собственные пути
- ml/civic_classifier/
- tests/civic/R08/
- research/round-11-results/R08/
- research/handoffs/astana/R08/round-11/STATUS.md

## Сделано к checkpoint 1
- Спецификация меток (labels.py), нормализация RU/KK без перевода казахских букв в латиницу (textnorm.py).
- Синтетический корпус: 75 шаблонов RU/KK + 83 рукописных пограничных примера; всё помечено synthetic.
- Pipeline: генерация → схема → exact dedup → кластеры близких дублей (Jaccard char-5 ≥ 0.8) → групповой split
  по шаблону → проверка утечек. train 1530 / validation 403 / test 400. Утечек 0.
- Модели только на stdlib: Multinomial NB (baseline), softmax-регрессия (candidate), JSON-артефакты с sha256 в реестре.
- classify(text, language) по civic-v1, lazy loading, безопасный failure mode.
- Демонстрационные метрики (synthetic!): test macro-F1 NB 0.46, softmax 0.65; на рукописных 0.75 / 0.78.

## Не запускалось
- Реальные метрики: NOT_RUN (нет разрешённого обезличенного корпуса).
- Дообучение многоязычного encoder: NOT_RUN (нет корпуса, нет torch, CPU).

## Следующий шаг
Тесты tests/civic/R08/, annotation_guide, dataset_manifest, MODEL_CARD, INTEGRATION, разбор ошибок.
