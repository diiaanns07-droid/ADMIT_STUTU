"""Training is deterministic: the same splits + seed give byte-identical artifacts."""

import os
import tempfile
import unittest

import _common  # noqa: F401

from ml.civic_classifier import artifact as art
from ml.civic_classifier.cli import SPLIT_DIR, select_threshold, train_variant
from ml.civic_classifier.corpus import load_splits


class TrainingReproducibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.splits, cls.man = load_splits(SPLIT_DIR)

    def _artifact_sha(self, variant):
        model, policy, thr, info, _ = train_variant(variant, self.splits)
        meta = {"model_version": "test", "training_data_status": "synthetic_only",
                "review_threshold": thr}
        with tempfile.TemporaryDirectory() as d:
            return art.dump_artifact(model, policy, meta, os.path.join(d, "m.json"))

    def test_nb_deterministic(self):
        self.assertEqual(self._artifact_sha("nb_char24"), self._artifact_sha("nb_char24"))

    def test_committed_baseline_matches_retraining(self):
        reg = art.read_registry()
        payload, _ = art.load_artifact("nb_char24")
        model, policy, thr, info, _ = train_variant("nb_char24", self.splits)
        self.assertEqual(payload["model"]["log_lik"], model.to_dict()["log_lik"])
        self.assertEqual(payload["review_threshold"], round(thr, 6))
        self.assertEqual(payload["meta"]["corpus_sha256"],
                         self.man["corpus_after_cleaning"]["sha256"])
        self.assertIn("nb_char24", reg["artifacts"])

    def test_threshold_selection(self):
        margins = [0.9, 0.8, 0.7, 0.2, 0.1]
        correct = [True, True, True, False, True]
        t, info = select_threshold(margins, correct, target_error=0.0)
        self.assertEqual(t, 0.7)
        t, info = select_threshold([0.5], [False], target_error=0.0)
        self.assertIn("no threshold", info["method"])


if __name__ == "__main__":
    unittest.main()
