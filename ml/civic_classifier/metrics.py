"""Classification metrics (pure Python)."""

from .labels import LABELS

NONE_LABEL = "<rejected>"


def confusion(y_true, y_pred, labels=LABELS):
    cols = list(labels) + [NONE_LABEL]
    m = {t: {p: 0 for p in cols} for t in labels}
    for t, p in zip(y_true, y_pred):
        m[t][p if p in labels else NONE_LABEL] += 1
    return m


def prf(y_true, y_pred, labels=LABELS):
    per = {}
    for lab in labels:
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == lab and p == lab)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != lab and p == lab)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == lab and p != lab)
        support = tp + fn
        prec = tp / (tp + fp) if tp + fp else None
        rec = tp / support if support else None
        if prec is None or rec is None:
            f1 = None if support == 0 else 0.0
        else:
            f1 = 0.0 if prec + rec == 0 else 2 * prec * rec / (prec + rec)
        per[lab] = {"precision": _r(prec), "recall": _r(rec), "f1": _r(f1), "support": support}
    present = [per[l]["f1"] for l in labels if per[l]["support"] > 0]
    macro = sum(present) / len(present) if present else None
    acc = (sum(1 for t, p in zip(y_true, y_pred) if t == p) / len(y_true)) if y_true else None
    return {"n": len(y_true), "accuracy": _r(acc), "macro_f1": _r(macro),
            "macro_f1_over_labels_present": len(present), "per_class": per}


def _r(x):
    return None if x is None else round(x, 4)
