"""R08: числа в model card совпадают с сгенерированными метриками; статус реальных данных честный."""

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if not (ROOT / "research/round-12-results/R08/metrics.json").exists():
    pytest.skip("NOT_RUN: каталог результатов R08 не перенесён (переносятся только ml/ и tests/)",
                allow_module_level=True)
CARD = (ROOT / "ml/civic_classifier/MODEL_CARD.md").read_text(encoding="utf-8").replace("\u2212", "-")
METRICS = json.loads((ROOT / "research/round-12-results/R08/metrics.json").read_text(encoding="utf-8"))


def test_card_numbers_match_metrics():
    test = METRICS["sets"]["test"]["methods"]
    probe = METRICS["sets"]["probe"]["methods"]
    sel = next(k for k in test if k.endswith("(selected)"))
    for value in (test[sel]["macro_f1"], test["keyword_heuristic"]["macro_f1"], probe[sel]["macro_f1"],
                  probe["keyword_heuristic"]["macro_f1"], test[sel]["ci_macro_f1"]["low"]):
        assert f"{value:.3f}" in CARD, value
    d = METRICS["sets"]["test"]["paired_delta_selected_minus_heuristic"]
    assert f"{d['delta']:+.3f}" in CARD and f"{d['low']:+.3f}" in CARD
    assert METRICS["model_version"] in CARD


def test_real_data_status_is_not_claimed():
    assert METRICS["real_data"]["status"] == "NOT_EVALUATED"
    assert "NOT_EVALUATED" in CARD and "не** экспертная" in CARD


def test_report_is_generated_from_same_numbers():
    report = (ROOT / "research/round-12-results/R08/EVAL_REPORT.md").read_text(encoding="utf-8")
    sel = next(k for k in METRICS["sets"]["test"]["methods"] if k.endswith("(selected)"))
    assert f"| {sel} | " in report and METRICS["model_version"] in report
