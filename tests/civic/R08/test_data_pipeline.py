"""Dataset schema, split manifest integrity and leakage detection (before oversampling)."""

import json
import os
import shutil
import tempfile
import unittest

from _common import rec

from ml.civic_classifier.corpus import (DATA_DIR, LeakageError, SchemaError, clean,
                                        load_splits, make_splits, records_hash,
                                        validate_record, verify_no_leakage, write_jsonl)

SPLIT_DIR = os.path.join(DATA_DIR, "splits")


class SchemaTests(unittest.TestCase):
    def test_valid(self):
        validate_record(rec(1, "Яма на дороге"))

    def test_invalid(self):
        bad = [
            dict(rec(1, "x"), label="urgent"),
            dict(rec(1, "x"), language="en"),
            dict(rec(1, "x"), source="eotinish_dump"),
            dict(rec(1, "x"), evidence_type="observed"),  # synthetic cannot claim observed
            dict(rec(1, "   ")),
            dict(rec(1, "я" * 2001)),
            {k: v for k, v in rec(1, "x").items() if k != "group"},
        ]
        for r in bad:
            with self.assertRaises(SchemaError, msg=str(r)[:80]):
                validate_record(r)


class LeakageTests(unittest.TestCase):
    def test_identical_documents_across_splits_detected(self):
        a = rec(1, "Во дворе не горят фонари", "lighting", "g1")
        b = rec(2, "во  дворе НЕ горят фонари", "lighting", "g2")  # same after normalisation
        with self.assertRaisesRegex(LeakageError, "exact"):
            verify_no_leakage({"train": [a], "validation": [], "test": [b]})

    def test_near_duplicates_across_splits_detected(self):
        a = rec(1, "На улице Кенесары огромная яма на дороге, машины пробивают колёса", "roads", "g1")
        b = rec(2, "На улице Кенесары огромная яма на дороге, машины пробивают колеса!", "roads", "g2")
        with self.assertRaisesRegex(LeakageError, "near"):
            verify_no_leakage({"train": [a], "validation": [b], "test": []})

    def test_same_group_across_splits_detected(self):
        a = rec(1, "Яма на дороге у школы", "roads", "tmpl-1")
        b = rec(2, "Тротуар разбит у подъезда", "sidewalks", "tmpl-1")
        with self.assertRaisesRegex(LeakageError, "group"):
            verify_no_leakage({"train": [a], "validation": [], "test": [b]})

    def test_clean_drops_exact_duplicates(self):
        kept, rep = clean([rec(1, "Яма!"), rec(2, "яма!"), rec(3, "Фонарь")])
        self.assertEqual(len(kept), 2)
        self.assertEqual(rep["exact_duplicates_dropped"][0]["duplicate_of"], "t-1")

    def test_make_splits_merges_near_dup_clusters(self):
        recs = []
        for k, lab in enumerate(["roads", "lighting"]):
            for g in range(4):
                for i in range(3):
                    recs.append(rec(f"{k}{g}{i}", f"уникальный текст {lab} шаблон {g} вариант {i} "
                                    + "абвгд" * (g + 1), lab, f"{lab}-{g}"))
        # a near-copy placed in another group must end up in the same split
        twin = dict(recs[0], id="twin", group="lighting-3", label="lighting")
        recs.append(twin)
        splits, report = make_splits(recs, seed=1)
        verify_no_leakage(splits)
        where = {r["id"]: s for s, rs in splits.items() for r in rs}
        self.assertEqual(where["twin"], where[recs[0]["id"]])

    def test_committed_splits_pass(self):
        splits, man = load_splits(SPLIT_DIR)
        self.assertEqual(man["oversampling"], "none")
        train_groups = {r["group"] for r in splits["train"]}
        for s in ("validation", "test"):
            self.assertFalse(train_groups & {r["group"] for r in splits[s]})
        self.assertFalse(any(r["source"] == "synthetic_handwritten" for r in splits["train"]))
        for s in splits.values():
            self.assertTrue(all(r["evidence_type"] == "synthetic" for r in s))


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for f in os.listdir(SPLIT_DIR):
            shutil.copy(os.path.join(SPLIT_DIR, f), self.tmp)
        self.man_path = os.path.join(self.tmp, "split_manifest.json")
        with open(self.man_path, encoding="utf-8") as f:
            self.man = json.load(f)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _save(self):
        with open(self.man_path, "w", encoding="utf-8") as f:
            json.dump(self.man, f)

    def test_copy_ok(self):
        load_splits(self.tmp)

    def test_hash_mismatch(self):
        self.man["splits"]["test"]["sha256"] = "0" * 64
        self._save()
        with self.assertRaisesRegex(SchemaError, "sha256"):
            load_splits(self.tmp)

    def test_missing_entry_and_garbage(self):
        del self.man["splits"]["validation"]
        self._save()
        with self.assertRaises(SchemaError):
            load_splits(self.tmp)
        with open(self.man_path, "w") as f:
            f.write("{not json")
        with self.assertRaises(SchemaError):
            load_splits(self.tmp)

    def test_path_in_manifest_rejected(self):
        self.man["splits"]["train"]["file"] = "../train.jsonl"
        self._save()
        with self.assertRaises(SchemaError):
            load_splits(self.tmp)

    def test_leak_injected_into_files_detected(self):
        # copy one train record into test and fix the hash so only leakage check can catch it
        tr = os.path.join(self.tmp, "train.jsonl")
        te = os.path.join(self.tmp, "test.jsonl")
        with open(tr, encoding="utf-8") as f:
            first = json.loads(f.readline())
        with open(te, encoding="utf-8") as f:
            test_recs = [json.loads(l) for l in f if l.strip()]
        leaked = dict(first, id="leaked-copy")
        test_recs.append(leaked)
        write_jsonl(te, test_recs)
        self.man["splits"]["test"]["sha256"] = records_hash(test_recs)
        self._save()
        with self.assertRaises(LeakageError):
            load_splits(self.tmp)


if __name__ == "__main__":
    unittest.main()
