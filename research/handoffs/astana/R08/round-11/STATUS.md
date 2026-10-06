# R08 — Обучаемая модель обращений · раунд 11 · Астана

Статус: DONE для обязательной части (baseline + candidate, тесты, документы); второй
эксперимент (encoder) и реальные метрики — NOT_RUN с причинами.

## Идентификация
- Роль: R08 (обучаемая модель обращений и эксперимент диплома)
- Репозиторий сессии: https://github.com/diiaanns07-droid/ADMIT_STUTU
  ВНИМАНИЕ: среда Claude Code выдала рабочую копию ADMIT_STUTU, а не ожидаемый GOV_DIPLOME.
  Remote не менялся (по правилам). Пакет раунда прочитан из GOV_DIPLOME (публичный, только чтение).
  R01 импортирует пути R08 из ADMIT_STUTU копированием (истории не связаны, merge не делать).
- Ветка: claude/eager-hawking-4up40k
- Исходный HEAD ветки: c698f7f3005842907a25299fd3cf50df2d0886a5 (ADMIT_STUTU main, к задаче не относится)
- PACK_SHA: 9c2f5c0dae14b46c0697a9dfc7f854351bfd570d (GOV_DIPLOME origin/codex/govtech-main-interface)
- Проверенный код: f6754e102971168832bb74cc364e13aea0ddd739 (push OK)

## Собственные пути
- ml/civic_classifier/
- tests/civic/R08/
- research/round-11-results/R08/
- research/handoffs/astana/R08/round-11/STATUS.md

## Что работает
- `from ml.civic_classifier import classify; classify(text, language)` — civic-v1, lazy loading,
  никогда не бросает исключение на вводе; пустой / >2000 символов / не ru-kk / латиница -> rejected_input;
  нет/битая модель -> model_unavailable. В каждом ответе model_version и training_data_status.
- Только stdlib Python; артефакты в JSON с sha256 в реестре, без pickle; ~1 МБ моделей.
- Синтетический корпус: 75 шаблонов (RU 38 / KK 37) -> 2250 + 83 рукописных пограничных.
  Групповой split по шаблонам, проверка утечек (точные/групповые/близкие дубли), oversampling нет.
- Модели: NB baseline (nb_char24), softmax-candidate (softmax_char25, по умолчанию, выбран по validation),
  ablation kk_fold.
- Демонстрационные метрики (СИНТЕТИКА): test macro-F1 NB 0.465 / softmax 0.654; 6-fold CV по шаблонам
  0.600±0.083 / 0.692±0.110; на рукописных разницы нет (0.745 / 0.739).
- ERROR_ANALYSIS.txt: механизмы ошибок (пробел покрытия «светофор»->lighting, доминирование ключевого
  слова с уверенными ошибками, откат в other), языки, kk_fold-эффект, порог.
- Stretch: active-review (id+хэш, без текста), export-annotation CSV, бенчмарк inference (~0.47 мс/сообщ.).

## Команды проверки
```
python3 -m ml.civic_classifier.cli build-data
python3 -m ml.civic_classifier.cli experiment
python3 -m ml.civic_classifier.cli cv
cd tests/civic/R08 && python3 -m unittest discover -s . -p "test_*.py"   # 43 tests OK
```

## Не запускалось
- Реальные метрики: NOT_RUN — нет разрешённого обезличенного корпуса (eOtinish/чаты не используются).
- Дообучение многоязычного encoder: NOT_RUN — нет корпуса, нет torch, только CPU.
- Встраивание в приложение: NOT_RUN — общие файлы у R01; адаптер в INTEGRATION.txt.

## Риски
- Все цифры — на синтетике, написанной агентом; казахский не проверен носителем; разметка одного автора.
- Уверенные ошибки на пограничных случаях порогом не ловятся -> только подсказка модератору.

## Следующий шаг
R01/R06: скопировать ml/civic_classifier/ и tests/civic/R08/ из f6754e1, подключить suggest_topic()
в staff-вид модерации по INTEGRATION.txt (категорию жителя не перезаписывать).
