"""R08: закреплённый синтетический корпус — детерминизм, group split без утечки, обезличивание."""

import json
import re

from ml.civic_classifier import corpus
from ml.civic_classifier.labels import LABELS
from ml.civic_classifier.text import normalize


def test_rebuild_is_byte_identical(tmp_path):
    m = corpus.build(tmp_path)
    pinned = json.loads(corpus.SPLIT_PATH.read_text(encoding="utf-8"))
    assert m["corpus_sha256"] == pinned["corpus_sha256"] == corpus.sha256_file(corpus.CORPUS_PATH)
    assert (tmp_path / corpus.SPLIT_PATH.name).read_bytes() == corpus.SPLIT_PATH.read_bytes()


def test_group_split_has_no_template_leak_and_no_exact_duplicates():
    rows, manifest = corpus.load_corpus()
    by_template = {}
    for r in rows:
        if r["split"] != "excluded_near_dup":
            by_template.setdefault(r["template_id"], set()).add(r["split"])
    assert all(len(s) == 1 for s in by_template.values())
    norms = [normalize(r["text"]) for r in rows]
    assert len(norms) == len(set(norms))
    train = {normalize(r["text"]) for r in rows if r["split"] == "train"}
    assert not any(normalize(r["text"]) in train for r in rows if r["split"] in ("val", "test"))
    assert manifest["evidence_type"] == "synthetic" and "not expert human" in manifest["labels_by"]


def test_every_label_in_every_split():
    rows, _ = corpus.load_corpus()
    for split in ("train", "val", "test"):
        assert {r["label"] for r in rows if r["split"] == split} == set(LABELS)


def test_corpus_contains_no_contact_data():
    text = corpus.CORPUS_PATH.read_text(encoding="utf-8")
    assert not re.search(r"\d{3}[ -]?\d{2}[ -]?\d{2}", text), "phone-like digits survived anonymization"
    assert "@" not in text
    manifest = json.loads(corpus.SPLIT_PATH.read_text(encoding="utf-8"))
    assert manifest["anonymized_markers"].get("phone", 0) > 0  # генератор действительно вставлял контакты


def test_probe_set_is_separate_from_generator():
    probe = [json.loads(x) for x in (corpus.DATA_DIR / "probe_agent_v1.jsonl").read_text(encoding="utf-8").splitlines()]
    rows, _ = corpus.load_corpus()
    corpus_norm = {normalize(r["text"]) for r in rows}
    assert len(probe) >= 100 and {p["label"] for p in probe} == set(LABELS)
    assert not any(normalize(p["text"]) in corpus_norm for p in probe)


def test_crlf_checkout_keeps_corpus_hash(tmp_path):
    """Windows autocrlf: хэш корпуса считается по каноническому LF; плюс ml/civic_classifier/.gitattributes -text."""
    crlf_corpus = tmp_path / corpus.CORPUS_PATH.name
    crlf_corpus.write_bytes(corpus.CORPUS_PATH.read_bytes().replace(b"\n", b"\r\n"))
    crlf_split = tmp_path / corpus.SPLIT_PATH.name
    crlf_split.write_bytes(corpus.SPLIT_PATH.read_bytes().replace(b"\n", b"\r\n"))
    rows, manifest = corpus.load_corpus(crlf_corpus, crlf_split)
    assert len(rows) == manifest["rows"]
    attrs = (corpus.DATA_DIR.parent / ".gitattributes").read_text(encoding="utf-8")
    assert "data/** -text" in attrs
