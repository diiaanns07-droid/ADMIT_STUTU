"""Отчёт раунда 13 из сохранённых JSON (audit.json, protocol_dev.json, protocol_challenge.json).

    python -m ml.civic_classifier report13 [--dir DIR]   -> DIR/EXPERIMENT_REPORT.md

Числа берутся только из файлов результатов. Для перечня расхождений на challenge-наборе предсказания
пересчитываются тем же замороженным кодом; сводка сверяется с единственным сохранённым запуском.
"""

from __future__ import annotations

import json
from pathlib import Path

from ml.civic_classifier.labels import LABELS

M5 = ("keyword", "logreg", "hybrid", "nb", "hybrid+abstain")
NAMES = {"keyword": "словарь (эвристика)", "logreg": "logreg (n-граммы)", "hybrid": "гибрид logreg+словарь",
         "nb": "Naive Bayes", "hybrid+abstain": "гибрид + отказ"}


def f(x, nd=3):
    return "—" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))


def table(header, rows):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def confusion_md(conf):
    m = conf["rows_true_cols_pred"]
    return table(["истина \\ прогноз"] + list(LABELS), [[LABELS[i]] + m[i] for i in range(len(LABELS))])


def summary_rows(block):
    return [[NAMES[m], f(block[m]["accuracy_all"]), f(block[m]["macro_f1_all"]), f(block[m]["coverage"]),
             f(block[m]["accuracy_accepted"]), block[m]["confident_errors"], f(block[m]["safe_outcome_rate"])]
            for m in M5]


SUMMARY_HEADER = ["метод", "точность (все)", "macro-F1 (все)", "покрытие", "точность принятых",
                  "уверенные ошибки", "безопасный исход"]


def discordance():
    from ml.civic_classifier.abstain import load_policy
    from ml.civic_classifier.corpus import load_corpus, sha256_file
    from ml.civic_classifier.model import load_model
    from ml.civic_classifier.protocol import CHALLENGE, DATA, predict_all, train_models
    rows, man = load_corpus()
    models = {"hybrid": load_model(), "nb": load_model(DATA / "model_alt_nb.json.gz"),
              "logreg": train_models([r for r in rows if r["split"] == "train"], man["corpus_sha256"],
                                     sha256_file(DATA / "split_v2.json"))["logreg"]}
    ch = [json.loads(x) for x in CHALLENGE.read_text(encoding="utf-8").splitlines() if x.strip()]
    preds = predict_all(models, ch, load_policy()["margin_threshold"])
    hk = sum(1 for r, h, k in zip(ch, preds["hybrid"], preds["keyword"]) if h["pred"] == r["label"] != k["pred"])
    kh = sum(1 for r, h, k in zip(ch, preds["hybrid"], preds["keyword"]) if k["pred"] == r["label"] != h["pred"])
    same_wrong = sum(1 for r, h, k in zip(ch, preds["hybrid"], preds["keyword"])
                     if h["pred"] == k["pred"] != r["label"])
    hyb_wrong = sum(1 for r, h in zip(ch, preds["hybrid"]) if h["pred"] != r["label"])
    acc = sum(1 for r, h in zip(ch, preds["hybrid"]) if h["pred"] == r["label"]) / len(ch)
    return {"hybrid_right_keyword_wrong": hk, "keyword_right_hybrid_wrong": kh,
            "both_wrong_same_label": same_wrong, "hybrid_wrong": hyb_wrong, "hybrid_accuracy_recomputed": round(acc, 4)}


def build(d: Path) -> str:
    audit = json.loads((d / "audit.json").read_text(encoding="utf-8"))
    dev = json.loads((d / "protocol_dev.json").read_text(encoding="utf-8"))
    chal = json.loads((d / "protocol_challenge.json").read_text(encoding="utf-8"))
    res = json.loads((d / "resources.json").read_text(encoding="utf-8")) if (d / "resources.json").exists() else None
    cv, fx, ch = dev["cv"], dev["fixed"], chal["fixed"]["challenge_r13_v1"]
    disc = discordance()
    assert disc["hybrid_accuracy_recomputed"] == ch["hybrid"]["accuracy_all"], "recomputed != stored single run"
    L = []
    a = L.append
    a("# R08 · раунд 13 · отчёт эксперимента: словарь vs обученная модель vs гибрид\n")
    a("**Все данные синтетические и размечены агентом. Качество на реальных обращениях: real_data_NOT_EVALUATED.**")
    a("Сгенерировано `python -m ml.civic_classifier report13` из audit.json, protocol_dev.json, protocol_challenge.json.\n")
    a("## 1. Главный вывод\n")
    sp, pv = cv["macro_f1_over_folds"], cv["paired_vs_keyword"]
    a(f"- По строгому протоколу (leave-family-out CV, {cv['folds']} фолдов, {cv['groups']} групп происхождения) "
      f"словарь {f(sp['keyword']['mean'])} ≈ гибрид {f(sp['hybrid']['mean'])} > logreg {f(sp['logreg']['mean'])} > "
      f"NB {f(sp['nb']['mean'])} (macro-F1, среднее по фолдам). Гибрид лучше словаря в "
      f"{pv['hybrid_minus_keyword']['folds_better']} из {pv['hybrid_minus_keyword']['folds']} фолдов, средняя разница "
      f"{pv['hybrid_minus_keyword']['mean']:+.3f}: **превосходство гибрида не подтверждено**. Чистая обученная модель "
      f"хуже словаря во всех фолдах ({pv['logreg_minus_keyword']['mean']:+.3f}).")
    a(f"- На замороженном challenge-наборе (n={ch['hybrid']['n']}, один запуск) гибрид {f(ch['hybrid']['macro_f1_all'])} "
      f"против словаря {f(ch['keyword']['macro_f1_all'])}: гибрид прав там, где словарь ошибся, в "
      f"{disc['hybrid_right_keyword_wrong']} сообщениях, обратное — в {disc['keyword_right_hybrid_wrong']}; "
      f"в {disc['both_wrong_same_label']} из {disc['hybrid_wrong']} ошибок гибрида (по основной метке) словарь выдаёт ту же неверную метку. Один агентский "
      "набор такого размера не доказывает преимущества.")
    a(f"- Гибрид делает больше уверенных ошибок (score ≥ 0.9), чем словарь (≥ 2 совпадения): CV "
      f"{cv['pooled']['hybrid']['confident_errors']} против {cv['pooled']['keyword']['confident_errors']}; "
      f"отказ снижает их до {cv['pooled']['hybrid+abstain']['confident_errors']} при покрытии "
      f"{f(cv['pooled']['hybrid+abstain']['coverage'])}. score не вероятность: у NB «уверены» почти все ответы "
      f"({cv['pooled']['nb']['confident_errors']} уверенных ошибок).")
    a("- Где полезна: ясные однотемные сообщения RU/KK/смешанные; где ошибается: адресные слова-ловушки, "
      "отрицание/благодарность, вне темы с совпадающей подстрокой, транслит и иностранный язык (только отказ).\n")

    a("## 2. Воспроизводимость и утечки\n")
    rp = audit["reproduction"]
    a(f"- Пересборка без сети: корпус `{rp['corpus_sha256_pinned'][:12]}…`, split и обе модели совпали побайтно: "
      f"**{rp['identical']}** (модель {rp['model_version']}).\n")
    lk = audit["leakage"]
    rows = [[s, v["rows"], v["max_train_jaccard_ge_0_6"], v["rows_whose_family_is_in_train"],
             v["rows_with_same_family_train_rows_in_another_language"], v["families"]] for s, v in lk["per_split"].items()]
    a(table(["split", "сообщений", "Jaccard к train ≥0.6", "семейство есть в train", "из них через перевод", "семейств"], rows))
    a(f"\nТочных дублей между splits: {lk['exact_duplicates_across_splits']}. Шаблонов {lk['templates']}, семейств "
      f"{lk['families']}, из них в нескольких splits: {lk['families_in_more_than_one_split']}.")
    lc = audit["lexical_circularity"]
    a(f"Круговая лексика: основа словаря своей метки есть в {lc['test']['share_with_gold_label_stem']*100:.0f} % "
      f"сообщений test и {lc['probe_agent_v1']['share_with_gold_label_stem']*100:.0f} % пробного набора — синтетика одного "
      "автора благоприятствует словарю. Основы STEMS не менялись после первого коммита (до корпуса и до test); "
      "гибридная архитектура выбрана после первого просмотра test (журнал раунда 12) → test раунда 12 = exploratory.\n")

    a("## 3. Основной протокол: leave-family-out CV\n")
    a(table(["метод", "среднее", "min", "max", "stdev"],
            [[NAMES[m], f(sp[m]["mean"]), f(sp[m]["min"]), f(sp[m]["max"]), f(sp[m]["stdev"])] for m in M5 if m != "hybrid+abstain"]))
    a("\nmacro-F1 по фолдам:\n")
    a(table(["фолд", "групп в проверке", "сообщений"] + [NAMES[m] for m in ("keyword", "logreg", "hybrid", "nb")],
            [[x["fold"], x["test_families"], x["test_rows"]] + [f(x[m]["macro_f1"]) for m in ("keyword", "logreg", "hybrid", "nb")]
             for x in cv["per_fold"]]))
    a("\nОбъединённые предсказания CV:\n")
    a(table(SUMMARY_HEADER, summary_rows(cv["pooled"])))
    a("\nF1 по классам (CV):\n")
    a(table(["класс"] + [NAMES[m] for m in ("keyword", "logreg", "hybrid")],
            [[lab] + [f(cv["pooled"][m]["per_class"][lab]["f1"]) for m in ("keyword", "logreg", "hybrid")] for lab in LABELS]))
    a("\nПо языкам (CV, macro-F1 / покрытие гибрида с отказом):\n")
    langs = sorted(cv["pooled"]["keyword"]["slices"]["language"])
    a(table(["язык", "n"] + [NAMES[m] for m in ("keyword", "logreg", "hybrid")] + ["покрытие с отказом"],
            [[lg, cv["pooled"]["keyword"]["slices"]["language"][lg]["n"]] +
             [f(cv["pooled"][m]["slices"]["language"][lg]["macro_f1"]) for m in ("keyword", "logreg", "hybrid")] +
             [f(cv["pooled"]["hybrid+abstain"]["slices"]["language"][lg]["coverage"])] for lg in langs]))
    a("\nМатрица ошибок, словарь (CV):\n")
    a(confusion_md(cv["pooled"]["keyword"]["confusion"]))
    a("\nМатрица ошибок, гибрид (CV):\n")
    a(confusion_md(cv["pooled"]["hybrid"]["confusion"]))

    a("\n## 4. Exploratory-наборы раунда 12 (уже просмотрены, не независимая проверка)\n")
    for name, title in (("test_r12_exploratory", "test раунда 12 (split по шаблонам; 87 % семейств есть в train)"),
                        ("probe_r12_exploratory", "пробный набор раунда 12 (112; ошибки разобраны в FAILURES.md)")):
        a(f"**{title}**\n")
        a(table(SUMMARY_HEADER, summary_rows(fx[name])))
        a("")
    a("На test раунда 12 гибрид выглядит лучше словаря, а в leave-family-out — нет: выигрыш объясняется "
      "семействами/переводами, общими для train и test.\n")

    a(f"## 5. Challenge_r13_v1 — замороженный набор, один запуск (sha256 `{chal['fixed']['challenge_sha256'][:12]}…`)\n")
    a("Разметка агентом; не жители и не независимые эксперты. После этого запуска набор — exploratory.\n")
    a(table(SUMMARY_HEADER, summary_rows(ch)))
    a("\nПо явлениям (точность словаря / гибрида; покрытие и безопасный исход гибрида с отказом):\n")
    ph = ch["hybrid+abstain"]["slices"]["phenomena"]
    a(table(["явление", "n", "словарь", "гибрид", "покрытие с отказом", "безопасный исход"],
            [[k, v["n"], f(ch["keyword"]["slices"]["phenomena"][k]["accuracy"]), f(ch["hybrid"]["slices"]["phenomena"][k]["accuracy"]),
              f(v["coverage"]), f(v["safe_outcome_rate"])] for k, v in sorted(ph.items(), key=lambda kv: -kv[1]["n"])]))
    a("\nПо языкам (гибрид с отказом):\n")
    lg = ch["hybrid+abstain"]["slices"]["language"]
    a(table(["язык", "n", "точность", "покрытие", "безопасный исход"],
            [[k, v["n"], f(v["accuracy"]), f(v["coverage"]), f(v["safe_outcome_rate"])] for k, v in sorted(lg.items())]))
    a("\nМатрица ошибок гибрида (challenge):\n")
    a(confusion_md(ch["hybrid"]["confusion"]))
    a(f"\nОшибки гибрида (метка вне {{label}} ∪ also_labels), {len(ch['errors_hybrid_abstain'])}:\n")
    a(table(["id", "явление", "истина", "прогноз", "score", "отказ", "словарь", "текст"],
            [[e["id"], ",".join(e["phenomena"]) if isinstance(e["phenomena"], list) else e["phenomena"], e["label"], e["pred"],
              f(e["score"]), ",".join(e["reasons"]) or "нет", e["keyword_pred"], e["text"][:60]] for e in ch["errors_hybrid_abstain"]]))
    a("\nМеханизмы: (1) подстрока словаря в чужом слове («недорого» ⊃ «дорог»); (2) адрес/ориентир называет объект "
      "(«живу возле остановки…», «дом у сквера»); (3) отрицание и благодарность («починили, спасибо»); (4) латиница — "
      "признаков нет, модель выдаёт почти константу, правило отказа срабатывает всегда. Механизмы 1–3 гибрид наследует от "
      "словаря и выдаёт уверенно (score > 0.9), без отказа.\n")

    a("## 6. Отказ и объяснение\n")
    a(f"- Политика {dev['policy']['version']}: multi_topic, latin_script, low_margin (M = {dev['policy']['margin_threshold']}, "
      "выбран на validation раунда 12), no_content. Определена до запуска challenge (PROTOCOL.md).")
    a("- Отказ передаётся в поля контракта: score = null, score_kind = \"abstain:<причины>\", needs_review = true.")
    a("- Объяснение: совпавшие основы словаря и до 3 «начал слов» с наибольшим вкладом против второй метки. Это "
      "признаки линейной модели, не причина. Иногда они выдают артефакты шаблонов (например, «рядом» в "
      "многотемном сообщении) — это видно сотруднику и полезно для разбора.\n")

    if res:
        a("## 7. Ресурсы\n")
        a(f"Файл модели {res['model_file_bytes']} байт; первый вызов с загрузкой {res['first_call_incl_load_s']} с; пик "
          f"выделений Python {res['python_alloc_peak_mb']} МБ; classify {res['classify_ms_mean']} мс в среднем, p95 "
          f"{res['classify_ms_p95']} мс (n={res['n']}). {res['env']}.\n")
    a("## 8. Границы применимости\n")
    a("- Только синтетика одного агента; качество на реальных обращениях неизвестно. Интервалы не публикуются для "
      "challenge (n мал, одна разметка); для CV указан разброс по 5 фолдам, а не доверительный интервал.")
    a("- Синтетическая версия всегда требует проверки сотрудником; score не вероятность; калибровка не выполнялась.")
    a("- Модель не определяет срочность, исполнителя, правоту сторон и не меняет категорию жителя.")
    return "\n".join(L) + "\n"
