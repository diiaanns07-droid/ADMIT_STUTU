"""R08: обучение воспроизводимо, артефакт — JSON без pickle, CLI predict работает без сети."""

import gzip
import json
import subprocess
import sys

import ml.civic_classifier as clf
from ml.civic_classifier import model as model_mod
from ml.civic_classifier import train as train_mod


def test_retrain_reproduces_committed_model_bytes(tmp_path):
    out = tmp_path / "model.json.gz"
    summary = train_mod.train(model_path=out)
    committed = model_mod.load_model()
    assert summary["payload_sha256"] == committed["payload_sha256"]
    assert out.read_bytes() == model_mod.DEFAULT_MODEL_PATH.read_bytes()
    # выбор и порог — только по validation (в артефакте нет тестовых метрик)
    sel = committed["selection"]
    assert sel["metric"] == "validation macro-F1" and "test" not in json.dumps(sel).lower()


def test_artifact_is_plain_json_with_provenance():
    raw = gzip.open(model_mod.DEFAULT_MODEL_PATH).read()
    assert raw.lstrip().startswith(b"{")  # не pickle
    m = json.loads(raw)
    assert m["training_data_status"] == "synthetic_demo_only;real_data_NOT_EVALUATED"
    assert m["score_kind"] == "softmax_max_uncalibrated" and m["evidence_type"] == "synthetic"
    assert m["corpus_sha256"] and m["split_sha256"] and m["version"].startswith("civic-clf-")


def test_trained_model_used_and_review_forced_for_synthetic():
    clf._state.clear()
    out = clf.classify("Фонари не горят во дворе", "ru")
    assert out["model_version"].startswith("civic-clf-") and out["model_version"] != clf.FALLBACK_VERSION
    assert out["label"] == "lighting" and isinstance(out["score"], float)
    assert out["needs_review"] is True  # synthetic_only: порог не переносится на реальных жителей


def test_cli_predict():
    res = subprocess.run([sys.executable, "-m", "ml.civic_classifier", "predict", "Аялдамадағы табло жұмыс істемейді"],
                         capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    assert json.loads(res.stdout)["label"] == "transport_stops"
