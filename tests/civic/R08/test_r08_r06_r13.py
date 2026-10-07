"""R08 раунд 13 × настоящий R06 (ui/civic_feedback): отказ, испорченный артефакт, таймаут, диагностика.

Работает с тем ui/civic_feedback, что лежит в checkout: база 56538a3 или поставка R06 раунда 12 (e0b4741).
Без ui/civic_feedback — skip (NOT_RUN), не PASS. Тексты — синтетические.
"""

from datetime import datetime, timezone
import gzip
import time

import pytest

feedback = pytest.importorskip("ui.civic_feedback", reason="NOT_RUN: ui.civic_feedback отсутствует в этой ветке")
from ui.civic_feedback import classifier_adapter  # noqa: E402
from ui.civic_feedback.fixtures import FIXTURE_EDITOR, fixture_context, fixture_object_lookup  # noqa: E402

import ml.civic_classifier as clf  # noqa: E402
import ml.civic_classifier.model as model_mod  # noqa: E402

R06_SUGGESTION_KEYS = {"label", "label_text", "score", "score_kind", "needs_review", "model_version",
                       "training_data_status"}


def clock():
    return datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)


def make(tmp_path, classifier, **limits):
    return feedback.FeedbackService(tmp_path / "fb.sqlite3", fixture_object_lookup, clock, classifier=classifier,
                                    limits=limits or None)


def submit(svc, text, category="other"):
    body = {"object_id": "demo-astana-work-01", "geometry": None, "category": category, "text": text,
            "consent_public": False}
    return svc.handle("POST", "/api/civic/v1/feedback", {}, body, None, fixture_context())


def queue(svc):
    ctx = fixture_context(csrf=FIXTURE_EDITOR["csrf_token"])
    resp = svc.handle("GET", "/api/civic/v1/staff/feedback", {"moderation": "pending"}, None, FIXTURE_EDITOR, ctx)
    assert resp["status"] == 200, resp
    return resp["body"]["data"]["items"]


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch):
    monkeypatch.setattr(clf, "_state", {})


def test_abstain_reaches_editor_queue_without_breaking_contract(tmp_path):
    svc = make(tmp_path, classifier_adapter.load_r08_classifier())
    try:
        text = "На Кенесары яма на дороге и рядом не горит фонарь"
        assert submit(svc, text, "lighting")["status"] == 201
        item = queue(svc)[0]
        assert item["category"] == "lighting"                       # выбор жителя не меняется
        assert item["classifier"]["status"] == "ok"
        sug = item["classifier"]["suggestion"]
        assert sug["score"] is None and sug["score_kind"] == "abstain:multi_topic" and sug["needs_review"] is True
        assert R06_SUGGESTION_KEYS <= set(sug)
        if set(sug) == R06_SUGGESTION_KEYS:
            # R06 без патча из INTEGRATION.txt хранит только поля контракта: abstain/explanation отбрасываются.
            return
        # R06 с предложенным патчем: ограниченные поля отказа и объяснения доходят до редактора.
        assert sug["abstain"] is True and sug["abstain_reasons"] == ["multi_topic"]
        assert set(sug["alternatives"]) <= set(clf.LABELS) and len(sug["alternatives"]) <= 2
        assert all(len(x) <= 40 for x in sug["explanation"]["keyword_stems"])
    finally:
        svc.close()


def test_corrupted_artifact_falls_back_and_message_is_saved(tmp_path, monkeypatch):
    bad = tmp_path / "model.json.gz"
    bad.write_bytes(gzip.compress(b'{"format": "civic-clf-model-v1", "labels": ["roads"]}'))
    monkeypatch.setattr(model_mod, "DEFAULT_MODEL_PATH", bad)
    svc = make(tmp_path, classifier_adapter.load_r08_classifier())
    try:
        assert submit(svc, "Во дворе не горят фонари", "lighting")["status"] == 201
        sug = queue(svc)[0]["classifier"]["suggestion"]
        assert sug["model_version"] == clf.FALLBACK_VERSION and sug["score"] is None
        assert sug["training_data_status"].startswith("no_trained_model")
    finally:
        svc.close()


def test_first_call_timeout_degrades_gracefully(tmp_path):
    """Загрузка модели не успевает за слишком малым таймаутом R06: сообщение сохраняется, статус timeout."""
    svc = make(tmp_path, clf.classify, classifier_timeout_s=0.0005)
    try:
        assert submit(svc, "Аялдамада орындық жоқ")["status"] == 201
        assert queue(svc)[0]["classifier"]["status"] == "timeout"
    finally:
        svc.close()
    deadline = time.monotonic() + 5
    while "model" not in clf._state and time.monotonic() < deadline:   # фоновая загрузка завершается
        time.sleep(0.05)
    assert "model" in clf._state


def test_real_load_fits_default_r06_timeout(tmp_path):
    svc = make(tmp_path, clf.classify)
    try:
        t0 = time.perf_counter()
        assert submit(svc, "Тротуар разбит возле школы", "sidewalks")["status"] == 201
        assert time.perf_counter() - t0 < feedback.service.DEFAULT_LIMITS["classifier_timeout_s"]
        assert queue(svc)[0]["classifier"]["status"] == "ok"
    finally:
        svc.close()


def test_r06_r12_probe_with_real_r08():
    if not hasattr(classifier_adapter, "r08_status"):
        pytest.skip("NOT_RUN: r08_status появился в поставке R06 раунда 12; в этой сборке его нет")
    status = classifier_adapter.r08_status()
    assert status["available"] is True and status["reason"] is None
    assert status["model_version"] == clf.model_info()["model_version"]
    assert status["training_data_status"] == "synthetic_demo_only;real_data_NOT_EVALUATED"
    assert classifier_adapter.check_suggestion(clf.classify("na ostanovke net navesa", "unknown")) is None
    assert classifier_adapter.check_suggestion(clf.classify("", "unknown")) is None
