"""R08: контракт classify() с ui/civic_feedback (CODE_BASE_SHA 56538a3), fallback и обезличивание."""

import json
import socket
import subprocess
import sys

import pytest

import ml.civic_classifier as clf
from ml.civic_classifier.labels import LABELS
from ml.civic_classifier.text import anonymize, detect_language, normalize

FEEDBACK_CATEGORIES = ("roads", "sidewalks", "transport_stops", "lighting", "landscaping", "other")
KEYS = {"label", "score", "score_kind", "needs_review", "model_version", "training_data_status"}


def test_labels_match_feedback_categories():
    assert LABELS == FEEDBACK_CATEGORIES


def r06_clean(value):
    """Копия правил ui/civic_feedback/service.py _clean_suggestion (56538a3)."""
    import math
    if not isinstance(value, dict) or value.get("label") not in FEEDBACK_CATEGORIES:
        return None
    score = value.get("score")
    if not (isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score)):
        score = None
    short = lambda k: value.get(k)[:80] if isinstance(value.get(k), str) else None  # noqa: E731
    return {"label": value["label"], "score": score, "score_kind": short("score_kind"),
            "needs_review": value.get("needs_review") is not False, "model_version": short("model_version"),
            "training_data_status": short("training_data_status")}


@pytest.mark.parametrize("text,lang", [
    ("Фонари не горят во дворе", "ru"), ("Аялдамада табло жұмыс істемейді", "kk"),
    ("Яма на дороге возле школы", "ru"), ("", "unknown"), ("!!!", "unknown"), ("ok", "unknown"),
    ("Тротуар жоқ, ходим по дороге", "kk"), ("x" * 20000, "unknown"),
])
def test_result_shape_is_accepted_by_r06(text, lang):
    out = clf.classify(text, lang)
    assert set(out) == KEYS
    cleaned = r06_clean(out)
    assert cleaned is not None and cleaned["label"] == out["label"]
    for k in ("score_kind", "model_version", "training_data_status"):
        assert isinstance(out[k], str) and 0 < len(out[k]) <= 80
    assert out["score"] is None or (0.0 <= out["score"] <= 1.0)
    assert isinstance(out["needs_review"], bool)


def test_non_string_text_raises_and_r06_marks_error():
    with pytest.raises(TypeError):
        clf.classify(None, "ru")


def test_fallback_when_model_missing(monkeypatch, tmp_path):
    import ml.civic_classifier.model as model_mod
    monkeypatch.setattr(model_mod, "DEFAULT_MODEL_PATH", tmp_path / "missing.json.gz")
    monkeypatch.setattr(clf, "_state", {})
    out = clf.classify("Фонари не горят", "ru")
    assert out["model_version"] == clf.FALLBACK_VERSION and out["score"] is None and out["needs_review"] is True
    assert out["label"] == "lighting"
    assert clf.model_info()["available"] is False


def test_corrupt_model_is_rejected(monkeypatch, tmp_path):
    import gzip
    import ml.civic_classifier.model as model_mod
    bad = tmp_path / "bad.json.gz"
    with gzip.open(bad, "wb") as gz:
        gz.write(json.dumps({"format": "civic-clf-model-v1", "labels": list(LABELS), "kind": "nb",
                             "features": [], "params": {}, "payload_sha256": "0" * 64}).encode())
    monkeypatch.setattr(model_mod, "DEFAULT_MODEL_PATH", bad)
    monkeypatch.setattr(clf, "_state", {})
    assert clf.classify("Яма на дороге", "ru")["model_version"] == clf.FALLBACK_VERSION
    assert "hash" in clf.model_info()["reason"]


def test_anonymize_removes_personal_data():
    text = "Звоните +7 (701) 123-45-67 или пишите ivan.petrov@mail.kz, ИИН 900101300123, https://t.me/x"
    anon, counts = anonymize(text)
    for leak in ("701", "123-45-67", "ivan", "900101300123", "t.me"):
        assert leak not in anon
    assert counts == {"url": 1, "email": 1, "phone": 1, "id": 1}
    assert "ivan" not in normalize(text) and "0000" not in normalize(text)


def test_detect_language_matches_feedback_rule():
    assert detect_language("Көше шамы жанбайды") == "kk"
    # Ограничение правила R06: казахский текст без специфических букв считается ru.
    assert detect_language("Шам жанбайды") == "ru"
    assert detect_language("Фонарь не горит") == "ru"
    assert detect_language("lamp broken") == "unknown" and detect_language("123") == "unknown"


def test_import_does_not_touch_network():
    code = ("import socket\n"
            "def boom(*a, **k): raise SystemExit('network used')\n"
            "socket.socket.connect = boom\nsocket.create_connection = boom\n"
            "import ml.civic_classifier as c\nprint(c.classify('Фонари не горят', 'ru')['label'])\n")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "lighting"
