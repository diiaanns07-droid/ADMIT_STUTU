"""Published result files must not overstate what was done."""

import hashlib
import json
import os
import unittest

from _common import REPO_ROOT

PKG = os.path.join(REPO_ROOT, "ml", "civic_classifier")
RES = os.path.join(REPO_ROOT, "research", "round-11-results", "R08")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class ResultHonestyTests(unittest.TestCase):
    def test_dataset_manifest_provenance(self):
        man = load(os.path.join(PKG, "data", "dataset_manifest.json"))
        self.assertEqual(man["training_data_status"], "synthetic_only")
        self.assertTrue(man["real_data_audit"]["result"])
        for c in man["corpora"]:
            self.assertTrue(c["license"])
            self.assertEqual(c["evidence_type"], "synthetic")
            self.assertFalse(c["human_reviewed"])
            with open(os.path.join(REPO_ROOT, c["file"]), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), c["sha256"], c["file"])

    def test_metrics_marked_demonstration(self):
        m = load(os.path.join(RES, "metrics.json"))
        self.assertEqual(m["metrics_kind"], "DEMONSTRATION_ON_SYNTHETIC_DATA")
        self.assertEqual(m["real_data_metrics"]["status"], "NOT_RUN")
        self.assertIsNone(m["real_data_metrics"]["macro_f1"])
        self.assertEqual(m["second_experiment_multilingual_encoder"]["status"], "NOT_RUN")
        self.assertIn("validation", m["selection_rule"])

    def test_active_review_has_no_text(self):
        path = os.path.join(RES, "active_review.json")
        if not os.path.exists(path):
            self.skipTest("active_review.json not generated")
        raw = open(path, encoding="utf-8").read()
        ar = json.loads(raw)
        for item in ar["items"]:
            self.assertNotIn("text", item)
        with open(os.path.join(PKG, "data", "splits", "test.jsonl"), encoding="utf-8") as f:
            sample = [json.loads(l)["text"] for l in f][:50]
        for t in sample:
            self.assertNotIn(t, raw)

    def test_registry_matches_files(self):
        reg = load(os.path.join(PKG, "model", "MODEL_REGISTRY.json"))
        self.assertIn(reg["default"], reg["artifacts"])
        for name, e in reg["artifacts"].items():
            with open(os.path.join(PKG, "model", e["file"]), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), e["sha256"], name)
            self.assertEqual(e["training_data_status"], "synthetic_only")


if __name__ == "__main__":
    unittest.main()
