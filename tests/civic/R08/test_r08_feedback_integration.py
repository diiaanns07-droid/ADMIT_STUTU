"""R08 × R06: настоящий ui.civic_feedback (CODE_BASE_SHA 56538a3) с моделью R08.

На ветке без ui/civic_feedback тест пропускается (skip, а не PASS). Проверка выполнена в worktree
56538a3 с перенесёнными путями R08 — см. research/round-12-results/R08/INTEGRATION.txt.
"""

from datetime import datetime, timezone
import time

import pytest

feedback = pytest.importorskip("ui.civic_feedback", reason="NOT_RUN: ui.civic_feedback отсутствует в этой ветке")
from ui.civic_feedback.classifier_adapter import load_r08_classifier  # noqa: E402
from ui.civic_feedback.fixtures import FIXTURE_EDITOR, fixture_context, fixture_object_lookup  # noqa: E402

import ml.civic_classifier as clf  # noqa: E402


def clock():
    return datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)


def make(tmp_path, classifier):
    return feedback.FeedbackService(tmp_path / "fb.sqlite3", fixture_object_lookup, clock, classifier=classifier)


def submit(svc, text, category):
    body = {"object_id": "demo-astana-work-01", "geometry": None, "category": category, "text": text,
            "consent_public": False}
    return svc.handle("POST", "/api/civic/v1/feedback", {}, body, None, fixture_context())


def queue(svc):
    ctx = fixture_context(csrf=FIXTURE_EDITOR["csrf_token"])
    resp = svc.handle("GET", "/api/civic/v1/staff/feedback", {"moderation": "pending"}, None, FIXTURE_EDITOR, ctx)
    assert resp["status"] == 200, resp
    return resp["body"]["data"]["items"]


def test_adapter_loads_r08_classify():
    assert load_r08_classifier() is clf.classify


def test_suggestion_stored_category_untouched(tmp_path):
    clf._state.clear()
    svc = make(tmp_path, load_r08_classifier())
    try:
        t0 = time.perf_counter()
        assert submit(svc, "Во дворе уже неделю не горят фонари, очень темно.", "roads")["status"] == 201
        assert time.perf_counter() - t0 < 2.0  # укладываемся в classifier_timeout_s R06 (включая загрузку модели)
        assert submit(svc, "Аялдамадағы электронды табло жұмыс істемейді.", "other")["status"] == 201
        items = {i["text"][:12]: i for i in queue(svc)}
        lamp = items["Во дворе уже"]
        assert lamp["category"] == "roads"  # выбор жителя не меняется подсказкой
        sug = lamp["classifier"]["suggestion"]
        assert lamp["classifier"]["status"] == "ok" and sug["label"] == "lighting"
        assert sug["model_version"].startswith("civic-clf-") and sug["needs_review"] is True
        assert sug["training_data_status"] == "synthetic_demo_only;real_data_NOT_EVALUATED"
        assert sug["score_kind"] == "softmax_max_uncalibrated" and 0 <= sug["score"] <= 1
        stop = items["Аялдамадағы "]
        assert stop["language"] == "kk" and stop["classifier"]["suggestion"]["label"] == "transport_stops"
    finally:
        svc.close()


def test_fallback_model_missing_still_ok(tmp_path, monkeypatch):
    import ml.civic_classifier.model as model_mod
    monkeypatch.setattr(model_mod, "DEFAULT_MODEL_PATH", tmp_path / "absent.json.gz")
    monkeypatch.setattr(clf, "_state", {})
    svc = make(tmp_path, load_r08_classifier())
    try:
        assert submit(svc, "Фонари не горят", "lighting")["status"] == 201
        item = queue(svc)[0]
        assert item["classifier"]["status"] == "ok"
        assert item["classifier"]["suggestion"]["model_version"] == clf.FALLBACK_VERSION
        assert item["classifier"]["suggestion"]["score"] is None
    finally:
        svc.close()
