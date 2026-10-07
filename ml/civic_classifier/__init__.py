"""R08 civic_classifier — подсказка категории сообщения жителя (RU/KK), раунды 12–13.

    classify(text, language) -> {label, score, score_kind, needs_review, model_version,
                                 training_data_status,
                                 # раунд 13, аддитивно (R06 может игнорировать):
                                 abstain, abstain_reasons, alternatives, explanation, policy_version}

Раунд 13: при отказе (несколько тем, латиница, малая разница оценок, пустой текст) score = None,
score_kind = "abstain:<причины>", label — лучшая метка только как подсказка, needs_review = True.

Контракт civic-v1 (CONTRACT.txt раздел 6) и ui/civic_feedback (CODE_BASE_SHA 56538a3):
label ∈ roads|sidewalks|transport_stops|lighting|landscaping|other. Импорт ничего не скачивает;
модель — локальный JSON (data/model.json.gz) с проверкой sha256. Если модели нет или она
повреждена, работает эвристика по ключевым словам: needs_review=True, score=None.
Подсказка не публикует сообщение, не определяет срочность или исполнителя.
"""

from __future__ import annotations

import logging
import threading

from ml.civic_classifier.labels import LABELS
from ml.civic_classifier.text import normalize

LOGGER = logging.getLogger(__name__)
FALLBACK_VERSION = "civic-clf-heuristic-fallback-v1"
FALLBACK_STATUS = "no_trained_model:keyword_heuristic"
MAX_TEXT = 5000

_lock = threading.Lock()
_state: dict = {}

__all__ = ["LABELS", "classify", "model_info"]


def _model():
    """Ленивая однократная загрузка; ошибка запоминается, повторно файл не читается."""
    if "model" in _state or "error" in _state:
        return _state.get("model")
    with _lock:
        if "model" not in _state and "error" not in _state:
            from ml.civic_classifier.model import ModelError, load_model
            try:
                _state["model"] = load_model()
            except ModelError as exc:
                _state["error"] = str(exc)
                LOGGER.info("civic_classifier: trained model unavailable (%s), keyword fallback", exc)
    return _state.get("model")


def model_info() -> dict:
    m = _model()
    if m is None:
        return {"available": False, "model_version": FALLBACK_VERSION, "reason": _state.get("error")}
    return {"available": True, "model_version": m["version"], "kind": m["kind"],
            "training_data_status": m["training_data_status"], "threshold": m["threshold"],
            "corpus_sha256": m["corpus_sha256"], "policy_version": _policy()["version"],
            "abstain_margin_threshold": _policy()["margin_threshold"]}


def _fallback(text: str) -> dict:
    from ml.civic_classifier.abstain import topic_labels
    from ml.civic_classifier.heuristic import STEMS, heuristic_label
    from ml.civic_classifier.text import normalize as _n
    label, _hits = heuristic_label(text)
    t = " " + _n(text) + " "
    return {"label": label, "score": None, "score_kind": "none", "needs_review": True,
            "model_version": FALLBACK_VERSION, "training_data_status": FALLBACK_STATUS,
            "abstain": len(topic_labels(text)) >= 2, "abstain_reasons": ["multi_topic"] if len(topic_labels(text)) >= 2 else [],
            "alternatives": [], "policy_version": "fallback",
            "explanation": {"kind": "keyword_match", "keyword_stems": [x.strip() for x in STEMS[label] if x in t][:5],
                            "word_prefixes": [], "versus": None,
                            "note": "совпадения словаря эвристики; модель недоступна"}}


def classify(text, language=None) -> dict:
    """Подсказка категории. language — 'ru'|'kk'|'unknown' от ui/civic_feedback (только для политики review)."""
    if not isinstance(text, str):
        raise TypeError("text must be str")
    text = text[:MAX_TEXT]
    model = _model()
    if model is None:
        return _fallback(text)
    from ml.civic_classifier.abstain import explain, load_policy, reasons
    from ml.civic_classifier.model import predict_scores
    policy = _policy()
    norm = normalize(text)
    base = {"model_version": model["version"], "training_data_status": model["training_data_status"],
            "policy_version": policy["version"]}
    if len(norm.replace(" ", "")) < 3:
        # Пустое/бессодержательное сообщение: модель не применяем.
        return dict(base, label="other", score=None, score_kind="abstain:no_content", needs_review=True,
                    abstain=True, abstain_reasons=["no_content"], alternatives=[], explanation=None)
    probs = predict_scores(text, model)
    order = sorted(range(len(LABELS)), key=lambda k: (-probs[k], k))
    best, second = order[0], order[1]
    score = round(probs[best], 4)
    why = reasons(text, probs, policy["margin_threshold"])
    # Пока модель обучена только на синтетике, порог (подобран на синтетической validation) не переносится
    # на реальных жителей: подсказка всегда требует проверки. Порог работает для модели с реальной оценкой.
    synthetic_only = model["training_data_status"].startswith("synthetic")
    needs_review = (synthetic_only or bool(why) or score < model["threshold"] or LABELS[best] == "other"
                    or language not in ("ru", "kk"))
    return dict(base, label=LABELS[best],
                score=None if why else score,
                score_kind=("abstain:" + ",".join(why))[:80] if why else model["score_kind"],
                needs_review=bool(needs_review), abstain=bool(why), abstain_reasons=why,
                alternatives=[LABELS[k] for k in order[1:3]],
                explanation=explain(text, model, best, second))


def _policy() -> dict:
    if "policy" not in _state:
        from ml.civic_classifier.abstain import load_policy
        _state["policy"] = load_policy()
    return _state["policy"]
