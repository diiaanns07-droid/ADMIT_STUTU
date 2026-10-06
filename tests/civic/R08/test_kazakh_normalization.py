"""Kazakh letters must survive normalisation; folding only maps to Cyrillic."""

import unittest

import _common  # noqa: F401

from ml.civic_classifier import classify, reset_cache
from ml.civic_classifier.features import DEFAULT_POLICY, extract
from ml.civic_classifier.textnorm import KK_FOLD, detect_language, kk_fold, normalize

KK = "әғқңөұүһі"


def has_latin(s):
    return any("a" <= ch.lower() <= "z" for ch in s)


class KazakhNormalizationTests(unittest.TestCase):
    def test_letters_preserved_upper_and_lower(self):
        self.assertEqual(normalize("ӘҒҚҢӨҰҮҺІ әғқңөұүһі"), "әғқңөұүһі әғқңөұүһі")

    def test_decomposed_input_composed(self):
        # "ә" can't be decomposed, but "й" (и + breve) and "ё" exercise NFC
        self.assertEqual(normalize("й"), "й")
        self.assertEqual(normalize("ёлка"), "елка")

    def test_never_maps_to_latin(self):
        for ch in KK:
            self.assertFalse(has_latin(normalize(ch)))
            self.assertFalse(has_latin(kk_fold(ch)))
        for v in KK_FOLD.values():
            self.assertFalse(has_latin(v))

    def test_homoglyph_repair_goes_to_cyrillic(self):
        # Latin "i" typed instead of Kazakh "і" in a Cyrillic word
        self.assertEqual(normalize("көшедегi"), "көшедегі")
        # Latin capital H imitates Russian Н
        self.assertEqual(normalize("Hет света"), "нет света")
        # all-Latin words are left untouched (not "repaired" into Cyrillic)
        self.assertEqual(normalize("Highvill"), "highvill")

    def test_fold_feature_policy_effect(self):
        on = dict(DEFAULT_POLICY, kk_fold=True)
        off = dict(DEFAULT_POLICY, kk_fold=False)
        correct = "шамдар жанбайды, қараңғы"
        typed = "шамдар жанбайды, караңгы".replace("ң", "н")
        f_on, f_off, f_typed = extract(correct, on), extract(correct, off), extract(typed, off)
        self.assertGreater(len(f_on), len(f_off))           # folding adds features ...
        self.assertTrue(set(f_off) <= set(f_on))             # ... never removes originals
        # folded features bridge the spelling without Kazakh letters
        self.assertGreater(len(set(f_on) & set(f_typed)), len(set(f_off) & set(f_typed)))

    def test_language_detection(self):
        self.assertEqual(detect_language("Аулада шамдар жанбайды")[0], "kk")
        self.assertEqual(detect_language("Во дворе не горят фонари")[0], "ru")
        self.assertEqual(detect_language("ок")[0], "und")
        self.assertEqual(detect_language("street light broken")[0], "unsupported_script")

    def test_classification_without_kazakh_letters(self):
        reset_cache()
        r = classify("аулада жарык жок, шамдар жанбайды")
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["label"], "lighting")


if __name__ == "__main__":
    unittest.main()
