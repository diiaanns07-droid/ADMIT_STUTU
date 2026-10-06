"""Artifact loading: checksum, path, format, label-set and failure mode."""

import importlib
import json
import os
import pickle
import shutil
import tempfile
import unittest

import _common  # noqa: F401  (sys.path)

from ml.civic_classifier import artifact as art
from ml.civic_classifier import reset_cache
from ml.civic_classifier.artifact import ArtifactError, load_artifact

clf = importlib.import_module("ml.civic_classifier.classify")


class ArtifactSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        reg = art.read_registry()
        self.name = reg["default"]
        entry = reg["artifacts"][self.name]
        shutil.copy(os.path.join(art.MODEL_DIR, entry["file"]), self.tmp)
        self.file = entry["file"]
        self.reg = {"default": self.name, "artifacts": {self.name: dict(entry)}}
        self._write_reg()

    def tearDown(self):
        shutil.rmtree(self.tmp)
        art.MODEL_DIR = art.os.path.join(art.PKG_DIR, "model")
        reset_cache()

    def _write_reg(self):
        with open(os.path.join(self.tmp, art.REGISTRY_NAME), "w") as f:
            json.dump(self.reg, f)

    def test_copy_loads(self):
        payload, model = load_artifact(model_dir=self.tmp)
        self.assertTrue(payload["model_version"])

    def test_tampered_artifact_rejected(self):
        p = os.path.join(self.tmp, self.file)
        with open(p, "rb") as f:
            data = f.read()
        with open(p, "wb") as f:
            f.write(data.replace(b'"review_threshold":', b'"review_threshold": ', 1))
        with self.assertRaisesRegex(ArtifactError, "sha256"):
            load_artifact(model_dir=self.tmp)

    def test_pickle_is_never_loaded(self):
        p = os.path.join(self.tmp, "evil.json")
        blob = pickle.dumps({"format": art.ARTIFACT_FORMAT})
        with open(p, "wb") as f:
            f.write(blob)
        self.reg["artifacts"]["evil"] = {"file": "evil.json",
                                         "sha256": art.sha256_bytes(blob)}
        self._write_reg()
        with self.assertRaises(ArtifactError):
            load_artifact("evil", model_dir=self.tmp)

    def test_path_traversal_rejected(self):
        for fname in ("../model/x.json", "/etc/passwd", "sub/x.json", "model.pkl"):
            self.reg["artifacts"]["bad"] = {"file": fname, "sha256": "0" * 64}
            self._write_reg()
            with self.assertRaises(ArtifactError, msg=fname):
                load_artifact("bad", model_dir=self.tmp)

    def test_nan_and_label_set_rejected(self):
        with open(os.path.join(self.tmp, self.file), encoding="utf-8") as f:
            payload = json.load(f)
        bad_variants = []
        p1 = json.loads(json.dumps(payload))
        p1["model"]["labels"] = p1["model"]["labels"][:-1] + ["urgent"]
        bad_variants.append(json.dumps(p1).encode())
        raw = json.dumps(payload).encode()
        bad_variants.append(raw.replace(b'"review_threshold": ', b'"review_threshold": NaN, "x": ', 1))
        p3 = json.loads(json.dumps(payload))
        p3["review_threshold"] = 7
        bad_variants.append(json.dumps(p3).encode())
        for i, blob in enumerate(bad_variants):
            fname = f"bad{i}.json"
            with open(os.path.join(self.tmp, fname), "wb") as f:
                f.write(blob)
            self.reg["artifacts"][f"bad{i}"] = {"file": fname, "sha256": art.sha256_bytes(blob)}
            self._write_reg()
            with self.assertRaises(ArtifactError, msg=f"variant {i}"):
                load_artifact(f"bad{i}", model_dir=self.tmp)

    def test_missing_model_gives_safe_response(self):
        os.remove(os.path.join(self.tmp, art.REGISTRY_NAME))
        art.MODEL_DIR = self.tmp
        reset_cache()
        r = clf.classify("Яма на дороге возле школы")
        self.assertEqual(r["status"], "model_unavailable")
        self.assertIsNone(r["label"])
        self.assertIsNone(r["model_version"])
        self.assertTrue(r["needs_review"])
        self.assertEqual(r["training_data_status"], "unknown")
        # empty input is still rejected predictably even without a model
        self.assertEqual(clf.classify("")["status"], "rejected_input")


if __name__ == "__main__":
    unittest.main()
