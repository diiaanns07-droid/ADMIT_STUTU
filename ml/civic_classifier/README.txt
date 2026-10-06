ml/civic_classifier — классификатор тем обращений RU/KK (R08, раунд 11)

Что это: воспроизводимый учебный классификатор-подсказка для очереди модерации.
Обучен ТОЛЬКО на синтетических текстах (training_data_status = synthetic_only).
Документы: MODEL_CARD.txt, annotation_guide.txt, data/dataset_manifest.json,
research/round-11-results/R08/{ERROR_ANALYSIS.txt, INTEGRATION.txt, metrics.json}.

Использование
    from ml.civic_classifier import classify
    classify("Во дворе не горят фонари", "ru")   # language: "ru" | "kk" | None (auto)

Команды (из корня репозитория, только стандартная библиотека Python)
    python -m ml.civic_classifier.cli build-data      # шаблоны+рукописные -> очистка -> split -> проверка утечек
    python -m ml.civic_classifier.cli experiment      # все варианты, выбор по validation, метрики, артефакты
    python -m ml.civic_classifier.cli cv              # 6-fold leave-templates-out (~2 мин)
    python -m ml.civic_classifier.cli train --variant nb_char24
    python -m ml.civic_classifier.cli evaluate --artifact default
    python -m ml.civic_classifier.cli predict "Аялдамада павильон жоқ"
    python -m ml.civic_classifier.cli active-review   # неуверенные id + хэши, без текста
    python -m ml.civic_classifier.cli export-annotation --input X.jsonl --out Y.csv
    python -m ml.civic_classifier.cli bench
Тесты
    cd tests/civic/R08 && python -m unittest discover -s . -p "test_*.py"

Структура
    labels.py      метки civic-v1 и определения
    textnorm.py    нормализация (казахские буквы сохраняются), эвристика языка
    features.py    символьные/словесные признаки; политика хранится в артефакте
    models.py      Multinomial NB, softmax-регрессия (pure Python), margin-score
    artifact.py    JSON-артефакт + sha256-реестр, без pickle
    classify.py    civic-v1 classify, lazy loading, безопасные отказы
    corpus.py      схема, генерация, dedup, близкие дубли, групповой split, проверка утечек
    metrics.py     P/R/F1, macro-F1, confusion
    cli.py         train/evaluate/experiment/cv/predict/active-review/export/bench
    data/          templates.json, handwritten.jsonl, splits/, schema.json, dataset_manifest.json
    model/         MODEL_REGISTRY.json, nb_char24.json, softmax_char25.json (~1 МБ всего)

Перегенерация полностью детерминирована (seed 20261006): повторный build-data +
experiment даёт те же sha256 корпуса и артефактов.
