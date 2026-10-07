"""Отказ (abstain) и ограниченное объяснение подсказки — раунд 13.

Правила зафиксированы в research/round-13-results/R08/PROTOCOL.md до запуска на challenge-наборе:
  R1 multi_topic  — совпадения словаря у >= 2 разных меток, кроме other;
  R2 latin_script — латинских букв > 50 % (транслит/иностранный язык; обучение — только кириллица);
  R3 low_margin   — разница двух лучших оценок < margin_threshold (выбран на validation раунда 12);
  R4 no_content   — < 3 значимых символов.
Отказ не меняет метку-подсказку и не публикует ничего: он говорит сотруднику «модель не берётся».

Объяснение — признаки линейной модели, а не причина и не свободный текст:
совпавшие основы словаря для выбранной метки и до 3 «начал слов» с наибольшим вкладом
(вес выбранной метки − вес второй метки) × значение признака.
"""

from __future__ import annotations

import json
from pathlib import Path

from ml.civic_classifier.labels import LABELS

POLICY_PATH = Path(__file__).resolve().parent / "data" / "abstain_r13.json"
POLICY_VERSION = "abstain-r13-v1"
MARGIN_GRID = tuple(round(0.05 * i, 2) for i in range(1, 11))  # 0.05 … 0.50
TARGET_ACCEPTED_ACCURACY = 0.95
EXPLAIN_NOTE = "признаки линейной модели, повлиявшие на выбор; не причина и не доказательство"


def latin_share(text: str) -> float:
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for ch in letters if "a" <= ch.lower() <= "z") / len(letters)


def topic_labels(text: str) -> list[str]:
    """Метки (кроме other), у которых совпала хотя бы одна основа словаря."""
    from ml.civic_classifier.heuristic import keyword_hits
    hits = keyword_hits(text)
    return [lab for lab in LABELS if lab != "other" and hits.get(lab)]


def reasons(text: str, probs: list[float], margin_threshold: float) -> list[str]:
    order = sorted(range(len(LABELS)), key=lambda k: (-probs[k], k))
    out = []
    if len(topic_labels(text)) >= 2:
        out.append("multi_topic")
    if latin_share(text) > 0.5:
        out.append("latin_script")
    if probs[order[0]] - probs[order[1]] < margin_threshold:
        out.append("low_margin")
    return out


def load_policy(path: Path | None = None) -> dict:
    path = POLICY_PATH if path is None else path
    try:
        policy = json.loads(path.read_text(encoding="utf-8"))
        m = float(policy["margin_threshold"])
        if not 0.0 <= m <= 1.0 or policy.get("version") != POLICY_VERSION:
            raise ValueError("bad policy")
        return policy
    except (OSError, ValueError, KeyError, TypeError):
        # Без файла политики отказываемся осторожно: любой неуверенный ответ — отказ.
        return {"version": POLICY_VERSION + "-fallback", "margin_threshold": 1.0}


def select_margin(model: dict, rows: list[dict]) -> dict:
    """Минимальный порог разницы, при котором точность непринятых к отказу >= цели (только validation)."""
    from ml.civic_classifier.model import predict_scores
    preds = []
    for r in rows:
        p = predict_scores(r["text"], model)
        order = sorted(range(len(LABELS)), key=lambda k: (-p[k], k))
        base = [x for x in reasons(r["text"], p, 0.0) if x != "low_margin"]
        preds.append((order[0] == LABELS.index(r["label"]), p[order[0]] - p[order[1]], bool(base)))
    grid = []
    for m in MARGIN_GRID:
        kept = [ok for ok, margin, other in preds if not other and margin >= m]
        grid.append({"margin": m, "coverage": round(len(kept) / len(preds), 4),
                     "accepted_accuracy": round(sum(kept) / len(kept), 4) if kept else None})
    ok = [g for g in grid if g["accepted_accuracy"] is not None and g["accepted_accuracy"] >= TARGET_ACCEPTED_ACCURACY]
    chosen = ok[0]["margin"] if ok else max((g for g in grid if g["accepted_accuracy"] is not None),
                                            key=lambda g: (g["accepted_accuracy"], -g["margin"]))["margin"]
    return {"version": POLICY_VERSION, "margin_threshold": chosen, "target_accepted_accuracy": TARGET_ACCEPTED_ACCURACY,
            "target_met": bool(ok), "selected_on": "round-12 validation split (template group split), n=%d" % len(rows),
            "grid": grid, "rules": ["multi_topic", "latin_script", "low_margin", "no_content"],
            "note": "Порог выбран на синтетической validation; на реальных сообщениях не проверен."}


def explain(text: str, model: dict, best: int, second: int, top: int = 3) -> dict:
    from ml.civic_classifier.heuristic import STEMS
    from ml.civic_classifier.model import vectorize
    from ml.civic_classifier.text import normalize
    t = " " + normalize(text) + " "
    stems = [s.strip() for s in STEMS[LABELS[best]] if s in t]
    items = []
    if model["kind"] == "logreg":
        vec = vectorize(text, model)
        w = model["params"]["weights"]
        feats = model["features"]
        contrib = []
        for i, v in vec.items():
            name = feats[i]
            if name.startswith("w:"):
                c = (w[i][best] - w[i][second]) * v
                if c > 0:
                    contrib.append((c, name[2:]))
        contrib.sort(key=lambda x: (-x[0], x[1]))
        items = [f"начало слова «{name}»" for _, name in contrib[:top]]
    return {"kind": "linear_feature_contributions", "keyword_stems": stems[:5], "word_prefixes": items,
            "versus": LABELS[second], "note": EXPLAIN_NOTE}
