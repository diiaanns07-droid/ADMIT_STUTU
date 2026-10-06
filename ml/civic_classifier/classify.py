"""civic-v1 ``classify(text, language)`` - lazy, thread-safe, never raises on input.

Response (every call, including failures):
{
  "schema_version": "civic-v1",
  "status": "ok" | "rejected_input" | "model_unavailable",
  "label": one of LABELS | null,      # null only when status != "ok"
  "score": float in [0,1] | null,     # UNCALIBRATED margin, not a probability
  "score_kind": str,                  # names the score; "none" when score is null
  "needs_review": bool,
  "review_reasons": [str],
  "alternatives": [label],            # next-best labels (max 2)
  "language": "ru"|"kk"|"mixed"|"und"|null,
  "language_source": "caller"|"detected"|null,
  "model_version": str | null,
  "training_data_status": str,        # e.g. "synthetic_only"
  "advisory": str
}
The label is a hint for sorting an editor queue. It does not decide urgency,
the responsible organisation, who is right, or any official commitment.
"""

import threading

from .artifact import ArtifactError, load_artifact
from .features import extract
from .labels import LABELS
from .models import score_from_decision
from .textnorm import detect_language, normalize, words

SCHEMA_VERSION = "civic-v1"
MAX_CHARS = 2000
MIN_LETTERS = 3
SUPPORTED_LANGUAGES = ("ru", "kk")
ADVISORY = ("Машинная подсказка темы для сортировки очереди. Не определяет срочность, "
            "исполнителя, правоту сторон или обязательство акимата; решение — за сотрудником.")
UNKNOWN_DATA_STATUS = "unknown"

_lock = threading.Lock()
_state = {"loaded": False, "payload": None, "model": None, "error": None}


def _load():
    if _state["loaded"]:
        return
    with _lock:
        if _state["loaded"]:
            return
        try:
            payload, model = load_artifact()
            _state.update(payload=payload, model=model, error=None)
        except ArtifactError as e:
            _state.update(payload=None, model=None, error=str(e))
        except Exception as e:  # defensive: model must never break the caller
            _state.update(payload=None, model=None, error=f"{type(e).__name__}: {e}")
        _state["loaded"] = True


def reset_cache():
    """Forget the loaded model (tests / after deploying a new artifact)."""
    with _lock:
        _state.update(loaded=False, payload=None, model=None, error=None)


def model_info():
    _load()
    p = _state["payload"]
    if p is None:
        return {"available": False, "error": _state["error"]}
    return {"available": True, "model_version": p["model_version"],
            "training_data_status": p["training_data_status"],
            "model_kind": p["model"]["kind"], "review_threshold": p["review_threshold"],
            "feature_policy": p["feature_policy"]}


def _base(status, payload=None):
    return {
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "label": None,
        "score": None,
        "score_kind": "none",
        "needs_review": True,
        "review_reasons": [],
        "alternatives": [],
        "language": None,
        "language_source": None,
        "model_version": payload["model_version"] if payload else None,
        "training_data_status": (payload["training_data_status"] if payload
                                 else UNKNOWN_DATA_STATUS),
        "advisory": ADVISORY,
    }


def _rejected(reason, payload, language=None, source=None):
    r = _base("rejected_input", payload)
    r["review_reasons"] = [reason]
    r["language"] = language
    r["language_source"] = source
    return r


def classify(text, language=None):
    try:
        return _classify(text, language)
    except Exception as e:  # never propagate into the feedback flow
        r = _base("model_unavailable", _state.get("payload"))
        r["review_reasons"] = [f"internal_error:{type(e).__name__}"]
        return r


def _classify(text, language):
    _load()
    return predict_with(_state["payload"], _state["model"], text, language)


def predict_with(payload, model, text, language=None):
    """Serving logic shared by classify() and offline evaluation."""
    if not isinstance(text, str):
        return _rejected("text_not_string", payload)
    if len(text) > MAX_CHARS:
        return _rejected("too_long", payload)
    norm = normalize(text)
    if sum(1 for ch in norm if ch.isalpha()) < MIN_LETTERS:
        return _rejected("empty_or_too_short", payload)

    detected, _ev = detect_language(text)
    if language in (None, "", "auto"):
        lang, source = detected, "detected"
    elif isinstance(language, str) and language.lower() in SUPPORTED_LANGUAGES:
        lang, source = language.lower(), "caller"
    else:
        return _rejected("unsupported_language", payload, None, "caller")
    if lang == "unsupported_script":
        return _rejected("unsupported_script", payload, None, source)

    if model is None or payload is None:
        r = _base("model_unavailable", None)
        r["review_reasons"] = ["model_unavailable"]
        r["language"], r["language_source"] = lang, source
        return r

    feats = extract(text, payload["feature_policy"])
    raw, used = model.decision(feats)
    ranked, margin, score_kind = score_from_decision(model.kind, raw, used)

    reasons = []
    if used == 0:
        reasons.append("no_known_features")
    if margin < payload["review_threshold"]:
        reasons.append("low_margin")
    if lang in ("mixed", "und"):
        reasons.append(f"language_{lang}")
    if source == "caller" and detected in SUPPORTED_LANGUAGES and detected != lang:
        reasons.append("language_mismatch")
    if len(words(norm)) <= 2:
        reasons.append("very_short")

    r = _base("ok", payload)
    r.update(
        label=ranked[0] if used else "other",
        score=margin if used else 0.0,
        score_kind=score_kind,
        needs_review=bool(reasons),
        review_reasons=reasons,
        alternatives=[lab for lab in ranked[1:3] if lab in LABELS],
        language=lang,
        language_source=source,
    )
    return r
