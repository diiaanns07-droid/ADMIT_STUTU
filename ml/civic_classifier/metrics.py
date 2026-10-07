"""Метрики классификации без сторонних библиотек: P/R/F1 по классам, macro-F1, матрица ошибок,
бутстрэп-интервал macro-F1 и ECE (ошибка калибровки) для max-score."""

from __future__ import annotations

import random

from ml.civic_classifier.labels import LABELS


def confusion(y_true, y_pred, k=len(LABELS)):
    m = [[0] * k for _ in range(k)]
    for t, p in zip(y_true, y_pred):
        m[t][p] += 1
    return m


def classification_report(y_true, y_pred) -> dict:
    k = len(LABELS)
    m = confusion(y_true, y_pred, k)
    per = {}
    f1s = []
    for c in range(k):
        tp = m[c][c]
        fp = sum(m[r][c] for r in range(k)) - tp
        fn = sum(m[c]) - tp
        support = sum(m[c])
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        per[LABELS[c]] = {"precision": round(prec, 4), "recall": round(rec, 4), "f1": round(f1, 4), "support": support}
        if support:
            f1s.append(f1)
    n = len(y_true)
    return {"n": n, "accuracy": round(sum(1 for t, p in zip(y_true, y_pred) if t == p) / n, 4) if n else None,
            "macro_f1": round(sum(f1s) / len(f1s), 4) if f1s else None, "per_class": per,
            "confusion": {"labels": list(LABELS), "rows_true_cols_pred": m},
            "macro_over": "классы с support > 0"}


def bootstrap_macro_f1(y_true, y_pred, n_boot=1000, seed=20261007) -> dict:
    if not y_true:
        return {"low": None, "high": None}
    rng = random.Random(seed)
    idx = list(range(len(y_true)))
    vals = []
    for _ in range(n_boot):
        s = [rng.choice(idx) for _ in idx]
        vals.append(classification_report([y_true[i] for i in s], [y_pred[i] for i in s])["macro_f1"] or 0.0)
    vals.sort()
    return {"low": round(vals[int(0.025 * n_boot)], 4), "high": round(vals[int(0.975 * n_boot) - 1], 4),
            "n_boot": n_boot, "level": 0.95}


def ece(correct, scores, bins=10) -> float | None:
    if not scores:
        return None
    total, err = len(scores), 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [i for i, s in enumerate(scores) if (lo < s <= hi) or (b == 0 and s == 0)]
        if sel:
            acc = sum(correct[i] for i in sel) / len(sel)
            conf = sum(scores[i] for i in sel) / len(sel)
            err += len(sel) / total * abs(acc - conf)
    return round(err, 4)
