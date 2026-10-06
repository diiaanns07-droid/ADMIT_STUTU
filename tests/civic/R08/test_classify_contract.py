"""civic-v1 classify(): schema, unknown input, reproducibility after reload, lazy load."""

import inspect
import json
import math
import os
import subprocess
import sys
import unittest

from _common import REPO_ROOT, RESPONSE_KEYS

from ml.civic_classifier import LABELS, classify, model_info, reset_cache
from ml.civic_classifier import classify as classify_mod


def check_schema(tc, r):
    tc.assertEqual(set(r), RESPONSE_KEYS)
    tc.assertEqual(r["schema_version"], "civic-v1")
    tc.assertIn(r["status"], ("ok", "rejected_input", "model_unavailable"))
    tc.assertIsInstance(r["needs_review"], bool)
    tc.assertIsInstance(r["review_reasons"], list)
    tc.assertIsInstance(r["training_data_status"], str)
    tc.assertTrue(r["advisory"])
    if r["status"] == "ok":
        tc.assertIn(r["label"], LABELS)
        tc.assertIsInstance(r["score"], float)
        tc.assertTrue(0.0 <= r["score"] <= 1.0 and math.isfinite(r["score"]))
        tc.assertIn("uncalibrated", r["score_kind"])  # never presented as probability
        tc.assertNotIn("prob", r["score_kind"])
        tc.assertIsInstance(r["model_version"], str)
        tc.assertTrue(set(r["alternatives"]) <= set(LABELS))
    else:
        tc.assertIsNone(r["label"])
        tc.assertIsNone(r["score"])
        tc.assertEqual(r["score_kind"], "none")
        tc.assertTrue(r["needs_review"])
        tc.assertTrue(r["review_reasons"])
    json.dumps(r)  # must be JSON-serialisable


class ContractTests(unittest.TestCase):
    def setUp(self):
        reset_cache()

    def test_signature_has_no_model_path(self):
        # No request-controlled path/pickle can reach the loader.
        self.assertEqual(list(inspect.signature(classify).parameters), ["text", "language"])

    def test_ok_ru_and_kk(self):
        for text, lang in [("Во дворе не горят фонари уже неделю", "ru"),
                           ("Аулада шамдар жанбайды, кешке қараңғы", "kk")]:
            r = classify(text, lang)
            check_schema(self, r)
            self.assertEqual(r["status"], "ok")
            self.assertEqual(r["label"], "lighting")
            self.assertEqual(r["training_data_status"], "synthetic_only")
            self.assertEqual(r["language"], lang)

    def test_unknown_inputs_are_predictable(self):
        cases = {
            "": "empty_or_too_short",
            "   \n\t": "empty_or_too_short",
            "?!...123": "empty_or_too_short",
            "x" * 2001: "too_long",
            "Pothole on the main road near school": "unsupported_script",
        }
        for text, reason in cases.items():
            r = classify(text)
            check_schema(self, r)
            self.assertEqual(r["status"], "rejected_input", text[:20])
            self.assertEqual(r["review_reasons"], [reason])
            self.assertIsNotNone(r["model_version"])  # version still reported
        for bad in (None, 42, b"bytes", ["list"]):
            r = classify(bad)
            check_schema(self, r)
            self.assertEqual(r["review_reasons"], ["text_not_string"])

    def test_unsupported_language_parameter(self):
        r = classify("Яма на дороге возле школы", "en")
        check_schema(self, r)
        self.assertEqual(r["review_reasons"], ["unsupported_language"])
        r = classify("Яма на дороге возле школы", "auto")
        self.assertEqual(r["status"], "ok")

    def test_boundary_length(self):
        text = ("яма на дороге " * 200)[:2000]
        self.assertEqual(len(text), 2000)
        self.assertEqual(classify(text)["status"], "ok")

    def test_mixed_and_short_need_review(self):
        r = classify("көшеде фонари не горят уже неделю, қараңғы")
        check_schema(self, r)
        self.assertTrue(r["needs_review"])
        r = classify("плохо")
        self.assertTrue(r["needs_review"])
        self.assertIn("very_short", r["review_reasons"])

    def test_language_mismatch_flagged(self):
        r = classify("Аулада шамдар жанбайды, кешке қараңғы", "ru")
        self.assertIn("language_mismatch", r["review_reasons"])
        self.assertTrue(r["needs_review"])

    def test_reproducible_after_reload(self):
        texts = ["Яма на проспекте", "Аялдамада павильон жоқ", "Сломаны качели во дворе",
                 "тротуар весь в ямах, бабушка упала"]
        first = [classify(t) for t in texts]
        reset_cache()
        second = [classify(t) for t in texts]
        self.assertEqual(first, second)
        # and in a fresh interpreter (no shared state at all)
        code = ("import json,sys;sys.path.insert(0,%r);from ml.civic_classifier import classify;"
                "print(json.dumps([classify(t) for t in %r],ensure_ascii=False))"
                % (REPO_ROOT, texts))
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                             check=True).stdout
        self.assertEqual(json.loads(out), first)

    def test_import_is_lazy(self):
        # module 'ml.civic_classifier.classify' is shadowed by the function in the package
        code = ("import sys,importlib;sys.path.insert(0,%r);import ml.civic_classifier;"
                "c=importlib.import_module('ml.civic_classifier.classify');"
                "print(c._state['loaded'])" % REPO_ROOT)
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                             check=True).stdout.strip()
        self.assertEqual(out, "False")

    def test_model_info(self):
        info = model_info()
        self.assertTrue(info["available"])
        self.assertEqual(info["training_data_status"], "synthetic_only")


if __name__ == "__main__":
    unittest.main()
