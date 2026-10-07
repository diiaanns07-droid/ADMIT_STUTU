"""R08 раунд 13: отказ, объяснение, протокол без утечки групп, заморозка challenge-набора."""

import hashlib
import json

import pytest

import ml.civic_classifier as clf
from ml.civic_classifier import abstain
from ml.civic_classifier.corpus import load_corpus
from ml.civic_classifier.heuristic import STEMS
from ml.civic_classifier.model import load_model
from ml.civic_classifier.protocol import CHALLENGE, CHALLENGE_FREEZE, family, family_folds, run_fixed


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(clf, "_state", {})


@pytest.mark.parametrize("text,reason", [
    ("На Кенесары яма на дороге и рядом не горит фонарь", "multi_topic"),
    ("vo dvore ne goryat fonari", "latin_script"),
    ("Street lights are off", "latin_script"),
])
def test_abstain_rules(text, reason):
    out = clf.classify(text, "ru")
    assert out["abstain"] is True and reason in out["abstain_reasons"]
    assert out["score"] is None and out["score_kind"].startswith("abstain:") and len(out["score_kind"]) <= 80
    assert out["needs_review"] is True and out["label"] in clf.LABELS


def test_clear_message_not_abstained_but_still_needs_review():
    out = clf.classify("Во дворе дома не горят фонари", "ru")
    assert out["abstain"] is False and out["label"] == "lighting" and out["needs_review"] is True


def test_explanation_uses_only_model_vocabulary_and_fixed_stems():
    text = "Иванов Пётр, тел. +7 701 234 56 78, ivanov@mail.kz: во дворе не горят фонари"
    out = clf.classify(text, "ru")
    exp = out["explanation"]
    model = load_model()
    vocab = {f[2:] for f in model["features"] if f.startswith("w:")}
    stems = {s.strip() for v in STEMS.values() for s in v}
    assert set(exp["keyword_stems"]) <= stems
    for item in exp["word_prefixes"]:
        prefix = item.split("«")[1].rstrip("»")
        assert prefix in vocab and not any(ch.isdigit() for ch in prefix) and "иван" not in prefix
    assert "не причина" in exp["note"]
    assert "ivanov" not in json.dumps(out, ensure_ascii=False) and "701" not in json.dumps(out)


@pytest.mark.parametrize("content", [None, "{not json", json.dumps({"version": "other", "margin_threshold": 0.2}),
                                     json.dumps({"version": abstain.POLICY_VERSION, "margin_threshold": 7})])
def test_missing_or_bad_policy_abstains_conservatively(tmp_path, content):
    path = tmp_path / "policy.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    policy = abstain.load_policy(path)
    assert policy["margin_threshold"] == 1.0 and policy["version"].endswith("fallback")


def test_pinned_policy_and_model_match():
    policy = abstain.load_policy()
    assert policy["margin_threshold"] == 0.25 and policy["model_payload_sha256"] == load_model()["payload_sha256"]
    assert "validation" in policy["selected_on"]


def test_family_folds_are_deterministic_and_disjoint():
    rows, _ = load_corpus()
    f1, f2 = family_folds(rows), family_folds(rows)
    assert f1 == f2 and len(f1) == 56
    by_fold = {}
    for fam, k in f1.items():
        by_fold.setdefault(k, set()).add(fam)
    assert sum(len(v) for v in by_fold.values()) == len(f1)          # каждая группа ровно в одном фолде
    for r in rows:                                                    # переводы/парафразы одной группы не делятся
        assert family(r) in f1


def test_challenge_is_frozen():
    freeze = json.loads(CHALLENGE_FREEZE.read_text(encoding="utf-8"))
    assert hashlib.sha256(CHALLENGE.read_bytes()).hexdigest() == freeze["sha256"]
    rows = [json.loads(x) for x in CHALLENGE.read_text(encoding="utf-8").splitlines() if x.strip()]
    assert len(rows) == freeze["rows"] and all(r["evidence_type"] == "synthetic" for r in rows)


def test_modified_challenge_is_rejected(monkeypatch, tmp_path):
    import ml.civic_classifier.protocol as protocol
    fake = tmp_path / "challenge.jsonl"
    fake.write_text(CHALLENGE.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    monkeypatch.setattr(protocol, "CHALLENGE", fake)
    with pytest.raises(SystemExit):
        run_fixed(["challenge"], 0.25)
