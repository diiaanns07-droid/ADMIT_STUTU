"""Обучение: мультиномиальный Naive Bayes и логистическая регрессия (softmax, SGD) — только stdlib.

Выбор метода/гиперпараметров и порога needs_review — ТОЛЬКО по validation. Тест не используется.
Финальная модель обучена на train (не train+val): порог подобран на предсказаниях именно этой модели.
Детерминизм: seed, сортированный словарь, фиксированный порядок перемешивания, округление весов.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
from pathlib import Path

from ml.civic_classifier.corpus import SPLIT_PATH, load_corpus, sha256_file
from ml.civic_classifier.labels import LABELS
from ml.civic_classifier.metrics import classification_report
from ml.civic_classifier.model import DEFAULT_MODEL_PATH, MODEL_FORMAT, canonical, load_model, predict_scores, save_model
from ml.civic_classifier.text import features

SEED = 20261007
FEATURE_PARAMS = {"char_ngrams": [2, 5], "word_prefix": 5}
MIN_DF = 2
NB_GRID = (0.05, 0.1, 0.3, 1.0)
LR_GRID = ({"l2": 1e-5, "epochs": 12, "lr0": 0.5}, {"l2": 1e-4, "epochs": 12, "lr0": 0.5},
           {"l2": 1e-5, "epochs": 24, "lr0": 0.5})
# Эксперимент 2 (после эксперимента 1, см. research/round-12-results/R08/EXPERIMENT_LOG.md): логистическая
# регрессия + признаки совпадений словаря эвристики. Отбор по-прежнему только по validation.
HYBRID_GRID = ({"l2": 1e-4, "epochs": 12, "lr0": 0.5, "keyword_scale": 0.5},
               {"l2": 1e-4, "epochs": 12, "lr0": 0.5, "keyword_scale": 1.0},
               {"l2": 1e-4, "epochs": 12, "lr0": 0.5, "keyword_scale": 2.0})
KW_FEATURES = ["k:" + lab for lab in LABELS] + ["k:none"]
REVIEW_TARGET_PRECISION = 0.90
THRESHOLD_GRID = tuple(round(0.30 + 0.05 * i, 2) for i in range(14))  # 0.30 … 0.95
TRAINING_DATA_STATUS = "synthetic_demo_only;real_data_NOT_EVALUATED"
SCORE_KIND = "softmax_max_uncalibrated"
DECIMALS = 6


def _raw(texts):
    return [features(t, char_ngrams=tuple(FEATURE_PARAMS["char_ngrams"]), word_prefix=FEATURE_PARAMS["word_prefix"])
            for t in texts]


def build_vocab(raw_docs) -> list[str]:
    df: dict[str, int] = {}
    for d in raw_docs:
        for f in d:
            df[f] = df.get(f, 0) + 1
    return sorted(f for f, n in df.items() if n >= MIN_DF)


def _lr_vec(doc, index, text=None, keyword_scale=None):
    vec = {index[f]: math.log1p(v) for f, v in doc.items() if f in index}
    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    vec = {i: v / norm for i, v in vec.items()}
    if keyword_scale is not None:
        from ml.civic_classifier.model import keyword_vector
        vec.update(keyword_vector(text, index, keyword_scale))
    return sorted(vec.items())


def train_nb(raw_docs, y, vocab, alpha) -> dict:
    K, V = len(LABELS), len(vocab)
    index = {f: i for i, f in enumerate(vocab)}
    counts = [[0.0] * K for _ in range(V)]
    totals = [0.0] * K
    prior = [0] * K
    for doc, k in zip(raw_docs, y):
        prior[k] += 1
        for f, v in doc.items():
            i = index.get(f)
            if i is not None:
                counts[i][k] += v
                totals[k] += v
    log_prob = [[round(math.log((counts[i][k] + alpha) / (totals[k] + alpha * V)), DECIMALS) for k in range(K)]
                for i in range(V)]
    n = sum(prior)
    log_prior = [round(math.log(prior[k] / n), DECIMALS) for k in range(K)]
    return {"log_prior": log_prior, "log_prob": log_prob}


def train_lr(raw_docs, y, vocab, l2, epochs, lr0, seed=SEED, texts=None, keyword_scale=None) -> dict:
    K, V = len(LABELS), len(vocab)
    index = {f: i for i, f in enumerate(vocab)}
    X = [_lr_vec(d, index, t, keyword_scale) for d, t in zip(raw_docs, texts or [None] * len(raw_docs))]
    w = [[0.0] * K for _ in range(V)]
    u = [[0.0] * K for _ in range(V)]  # накопитель для усреднения весов
    b, ub = [0.0] * K, [0.0] * K
    rng = random.Random(seed)
    order = list(range(len(X)))
    c = 1
    for epoch in range(epochs):
        rng.shuffle(order)
        lr = lr0 / (1.0 + epoch)
        for n in order:
            x, target = X[n], y[n]
            scores = list(b)
            for i, v in x:
                row = w[i]
                for k in range(K):
                    scores[k] += row[k] * v
            m = max(scores)
            exps = [math.exp(s - m) for s in scores]
            z = sum(exps)
            for k in range(K):
                g = exps[k] / z - (1.0 if k == target else 0.0)
                if g != 0.0:
                    b[k] -= lr * g
                    ub[k] += c * lr * g
                for i, v in x:
                    delta = lr * (g * v + l2 * w[i][k])
                    w[i][k] -= delta
                    u[i][k] += c * delta
            c += 1
    weights = [[round(w[i][k] - u[i][k] / c, DECIMALS) for k in range(K)] for i in range(V)]
    bias = [round(b[k] - ub[k] / c, DECIMALS) for k in range(K)]
    return {"weights": weights, "bias": bias}


def _model_dict(kind, vocab, params, hyper, corpus_sha, split_sha, threshold=0.5, feature_params=None) -> dict:
    fp = feature_params or FEATURE_PARAMS
    cfg = {"kind": kind, "hyper": hyper, "feature_params": fp, "min_df": MIN_DF, "seed": SEED}
    cfg_hash = hashlib.sha256(canonical(cfg)).hexdigest()
    tag = kind + ("-kw" if fp.get("keyword_features") else "")
    return {
        "format": MODEL_FORMAT, "kind": kind, "labels": list(LABELS), "feature_params": fp,
        "features": vocab, "params": params, "threshold": threshold, "score_kind": SCORE_KIND,
        "training_data_status": TRAINING_DATA_STATUS,
        "version": f"civic-clf-{tag}-c{corpus_sha[:8]}-p{cfg_hash[:8]}",
        "corpus_sha256": corpus_sha, "split_sha256": split_sha, "train_config": cfg,
        "trained_on": "train split only (group split by template)",
        "evidence_type": "synthetic",
        "created_by": "ml/civic_classifier/train.py",
    }


def _predict_labels(model, texts):
    model = dict(model)
    model["_index"] = {f: i for i, f in enumerate(model["features"])}
    out = []
    for t in texts:
        p = predict_scores(t, model)
        k = max(range(len(LABELS)), key=lambda j: (p[j], -j))
        out.append((k, p[k]))
    return out


def choose_threshold(preds, y) -> dict:
    """Минимальный порог, при котором точность принятых без проверки (score>=t, label!=other) >= цели."""
    rows = []
    for t in THRESHOLD_GRID:
        acc = [(k == yy) for (k, s), yy in zip(preds, y) if s >= t and LABELS[k] != "other"]
        prec = sum(acc) / len(acc) if acc else None
        rows.append({"threshold": t, "auto_share": round(len(acc) / len(y), 4),
                     "precision_auto": None if prec is None else round(prec, 4)})
    ok = [r for r in rows if r["precision_auto"] is not None and r["precision_auto"] >= REVIEW_TARGET_PRECISION]
    if ok:
        chosen = ok[0]["threshold"]
    else:  # цель недостижима: порог с максимальной точностью (при равенстве — меньший, больше покрытие)
        scored = [r for r in rows if r["precision_auto"] is not None]
        chosen = max(scored, key=lambda r: (r["precision_auto"], -r["threshold"]))["threshold"] if scored else 1.0
    return {"chosen": chosen, "target_precision": REVIEW_TARGET_PRECISION, "target_met": bool(ok), "grid": rows,
            "note": "подобран только на validation; если цель недостижима — порог с максимальной точностью"}


def train(model_path: Path = DEFAULT_MODEL_PATH, report_path: Path | None = None) -> dict:
    rows, manifest = load_corpus()
    corpus_sha, split_sha = manifest["corpus_sha256"], sha256_file(SPLIT_PATH)
    tr = [r for r in rows if r["split"] == "train"]
    va = [r for r in rows if r["split"] == "val"]
    raw_tr = _raw([r["text"] for r in tr])
    y_tr = [LABELS.index(r["label"]) for r in tr]
    y_va = [LABELS.index(r["label"]) for r in va]
    vocab = build_vocab(raw_tr)
    candidates = []
    for alpha in NB_GRID:
        hyper = {"alpha": alpha}
        m = _model_dict("nb", vocab, train_nb(raw_tr, y_tr, vocab, alpha), hyper, corpus_sha, split_sha)
        preds = _predict_labels(m, [r["text"] for r in va])
        rep = classification_report(y_va, [k for k, _ in preds])
        candidates.append({"kind": "nb", "hyper": hyper, "val_macro_f1": rep["macro_f1"], "model": m, "preds": preds})
    for hyper in LR_GRID:
        m = _model_dict("logreg", vocab, train_lr(raw_tr, y_tr, vocab, **hyper), hyper, corpus_sha, split_sha)
        preds = _predict_labels(m, [r["text"] for r in va])
        rep = classification_report(y_va, [k for k, _ in preds])
        candidates.append({"kind": "logreg", "hyper": hyper, "val_macro_f1": rep["macro_f1"], "model": m, "preds": preds})
    texts_tr = [r["text"] for r in tr]
    vocab_kw = sorted(set(vocab) | set(KW_FEATURES))
    for hyper in HYBRID_GRID:
        scale = hyper["keyword_scale"]
        fp = dict(FEATURE_PARAMS, keyword_features=True, keyword_scale=scale)
        lr_h = {k: v for k, v in hyper.items() if k != "keyword_scale"}
        params = train_lr(raw_tr, y_tr, vocab_kw, **lr_h, texts=texts_tr, keyword_scale=scale)
        m = _model_dict("logreg", vocab_kw, params, hyper, corpus_sha, split_sha, feature_params=fp)
        preds = _predict_labels(m, [r["text"] for r in va])
        rep = classification_report(y_va, [k for k, _ in preds])
        candidates.append({"kind": "logreg+keywords", "hyper": hyper, "val_macro_f1": rep["macro_f1"], "model": m,
                           "preds": preds})
    # Справка (не кандидат для runtime): эвристика на том же validation.
    from ml.civic_classifier.heuristic import heuristic_label
    heur_val = classification_report(y_va, [LABELS.index(heuristic_label(r["text"])[0]) for r in va])["macro_f1"]
    # Лучший по val macro-F1; при равенстве — первый в списке (NB проще, затем меньшее число эпох).
    best = max(candidates, key=lambda c: c["val_macro_f1"])
    thr = choose_threshold(best["preds"], y_va)
    model = dict(best["model"], threshold=thr["chosen"])
    model["selection"] = {"metric": "validation macro-F1", "chosen": {"kind": best["kind"], "hyper": best["hyper"]},
                          "candidates": [{"kind": c["kind"], "hyper": c["hyper"], "val_macro_f1": c["val_macro_f1"]}
                                         for c in candidates],
                          "threshold": {k: v for k, v in thr.items()},
                          "reference_keyword_heuristic_val_macro_f1": heur_val}
    payload = save_model(model, model_path)
    load_model(model_path)  # проверка, что артефакт читается
    # Второй (не выбранный) метод тоже сохраняется для сравнения в отчёте, рядом с основной моделью.
    # Альтернатива для отчёта: лучший кандидат другого семейства (NB, если выбран логрег/гибрид).
    other_kind = "nb" if best["kind"] != "nb" else "logreg"
    alt = max((c for c in candidates if c["kind"] == other_kind), key=lambda c: c["val_macro_f1"])
    alt_model = dict(alt["model"], threshold=choose_threshold(alt["preds"], y_va)["chosen"],
                     selection={"note": "альтернативный метод для сравнения; в runtime не используется"})
    alt_path = model_path.with_name(f"model_alt_{other_kind}.json.gz")
    save_model(alt_model, alt_path)
    summary = {"model_path": str(model_path.name), "payload_sha256": payload, "version": model["version"],
               "kind": model["kind"], "threshold": model["threshold"], "vocab_size": len(model["features"]),
               "train_rows": len(tr), "val_rows": len(va), "corpus_sha256": corpus_sha, "split_sha256": split_sha,
               "file_sha256": sha256_file(model_path), "alt_model": alt_path.name, "selection": model["selection"]}
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(summary, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return summary
