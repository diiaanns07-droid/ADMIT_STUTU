"""Command line interface. Run from the repository root:

    python -m ml.civic_classifier.cli build-data
    python -m ml.civic_classifier.cli experiment          # train all variants, evaluate, register default
    python -m ml.civic_classifier.cli train --variant nb_char24
    python -m ml.civic_classifier.cli evaluate --artifact default
    python -m ml.civic_classifier.cli cv                  # 6-fold leave-templates-out comparison
    python -m ml.civic_classifier.cli predict "Фонари не горят во дворе" [--language ru]
    python -m ml.civic_classifier.cli active-review       # uncertain validation/test ids, no text
    python -m ml.civic_classifier.cli export-annotation --out FILE.csv
    python -m ml.civic_classifier.cli bench

Everything is deterministic for a fixed seed; see train_manifest.json.
"""

import argparse
import csv
import hashlib
import json
import os
import platform
import sys
import time

from . import artifact as art
from .classify import predict_with, reset_cache
from .corpus import (DATA_DIR, SPLITS, clean, generate_from_templates, load_splits,
                     make_splits, read_jsonl, records_hash, summarize, verify_no_leakage,
                     write_jsonl)
from .features import DEFAULT_POLICY, extract
from .labels import LABELS
from .textnorm import kk_fold, normalize
from .metrics import confusion, prf
from .models import MultinomialNB, SoftmaxLinear, MajorityClass, score_from_decision

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(PKG_DIR, "..", ".."))
SPLIT_DIR = os.path.join(DATA_DIR, "splits")
RESULTS_DIR = os.path.join(REPO_ROOT, "research", "round-11-results", "R08")
SEED = 20261006
MODEL_VERSION_BASE = "civic-clf-r11"
TRAINING_DATA_STATUS = "synthetic_only"
TARGET_ACCEPTED_ERROR = 0.05

VARIANTS = {
    "majority": {"model": "majority", "policy": {}},
    "nb_char24": {"model": "nb", "policy": {"char_ngram_min": 2, "char_ngram_max": 4,
                                            "word_unigrams": True, "kk_fold": False}},
    "nb_char24_kkfold": {"model": "nb", "policy": {"char_ngram_min": 2, "char_ngram_max": 4,
                                                   "word_unigrams": True, "kk_fold": True}},
    "softmax_char25": {"model": "softmax", "policy": {"char_ngram_min": 2, "char_ngram_max": 5,
                                                      "word_unigrams": True, "kk_fold": False}},
    "softmax_char25_kkfold": {"model": "softmax", "policy": {"char_ngram_min": 2,
                                                             "char_ngram_max": 5,
                                                             "word_unigrams": True,
                                                             "kk_fold": True}},
}
BASELINE = "nb_char24"


def _json_dump(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=False)
        f.write("\n")


def _file_sha(path):
    return art.sha256_file(path)


# ------------------------------------------------------------------ data
def cmd_build_data(args):
    with open(os.path.join(DATA_DIR, "templates.json"), encoding="utf-8") as f:
        templates = json.load(f)
    gen = generate_from_templates(templates, per_template=args.per_template, seed=SEED)
    hw = read_jsonl(os.path.join(DATA_DIR, "handwritten.jsonl"))
    for r in gen:
        from .corpus import validate_record
        validate_record(r)
    raw = gen + hw
    cleaned, clean_report = clean(raw)
    splits, split_report = make_splits(cleaned, seed=SEED)
    verify_no_leakage(splits)  # before any (absent) oversampling
    os.makedirs(SPLIT_DIR, exist_ok=True)
    man = {"schema": "civic-r08-split-manifest-v1", "seed": SEED,
           "method": "group split: per (language,label) 1 template->test, 1->validation, "
                     "rest->train; handwritten records only validation/test (alternating "
                     "per label after seeded shuffle); near-duplicate clusters "
                     "(char-5 shingle Jaccard>=0.8) merged before final assignment",
           "near_dup_threshold": 0.8, "oversampling": "none",
           "inputs": {"templates.json": _file_sha(os.path.join(DATA_DIR, "templates.json")),
                      "handwritten.jsonl": _file_sha(os.path.join(DATA_DIR, "handwritten.jsonl"))},
           "corpus_after_cleaning": summarize(cleaned),
           "cleaning": {"raw_records": len(raw),
                        "exact_duplicates_dropped": len(clean_report["exact_duplicates_dropped"])},
           "split_report": split_report,
           "leakage_check": "PASS (exact, group, near-duplicate across all split pairs)",
           "splits": {}}
    for s in SPLITS:
        fname = f"{s}.jsonl"
        write_jsonl(os.path.join(SPLIT_DIR, fname), splits[s])
        info = summarize(splits[s])
        info["file"] = fname
        info["sha256"] = records_hash(splits[s])
        man["splits"][s] = info
    _json_dump(man, os.path.join(SPLIT_DIR, "split_manifest.json"))
    print(json.dumps({s: man["splits"][s]["n"] for s in SPLITS}, ensure_ascii=False))
    print("corpus sha256:", man["corpus_after_cleaning"]["sha256"])
    return man


# ------------------------------------------------------------------ train
def _make_model(kind):
    if kind == "nb":
        return MultinomialNB(LABELS, alpha=0.5, min_df=2)
    if kind == "softmax":
        return SoftmaxLinear(LABELS, epochs=12, lr=0.5, l2=1e-4, min_df=2, seed=SEED % 1000)
    if kind == "majority":
        return MajorityClass(LABELS)
    raise ValueError(kind)


def _policy(v):
    p = dict(DEFAULT_POLICY)
    p.update(VARIANTS[v]["policy"])
    return p


def select_threshold(margins, correct, target_error=TARGET_ACCEPTED_ERROR):
    """Smallest margin threshold t such that error among validation items with
    margin >= t is <= target_error. Returns (t, info). Method recorded in manifests."""
    cands = sorted(set([0.0] + list(margins)))
    best = None
    for t in cands:
        acc_idx = [i for i, m in enumerate(margins) if m >= t]
        if not acc_idx:
            continue
        err = sum(1 for i in acc_idx if not correct[i]) / len(acc_idx)
        if err <= target_error:
            best = (t, err, len(acc_idx) / len(margins))
            break
    if best is None:
        t = max(margins) if margins else 1.0
        return t, {"method": "no threshold met target; flag (almost) everything",
                   "target_accepted_error": target_error}
    return best[0], {"method": "smallest validation margin threshold with accepted-error "
                               f"<= {target_error}",
                     "target_accepted_error": target_error,
                     "validation_accepted_error": round(best[1], 4),
                     "validation_coverage": round(best[2], 4)}


def _payload(model, policy, threshold, version):
    return {"model_version": version, "training_data_status": TRAINING_DATA_STATUS,
            "feature_policy": policy, "review_threshold": threshold,
            "model": {"kind": model.kind}}


def train_variant(variant, splits):
    policy = _policy(variant)
    model = _make_model(VARIANTS[variant]["model"])
    t0 = time.perf_counter()
    X = [extract(r["text"], policy) for r in splits["train"]]
    y = [r["label"] for r in splits["train"]]
    model.fit(X, y)
    train_s = time.perf_counter() - t0
    if model.kind == "majority":
        return model, policy, 1.0, {"method": "n/a"}, train_s
    # threshold on validation
    margins, correct = [], []
    for r in splits["validation"]:
        raw, used = model.decision(extract(r["text"], policy))
        ranked, margin, _ = score_from_decision(model.kind, raw, used)
        margins.append(margin)
        correct.append(ranked[0] == r["label"])
    thr, info = select_threshold(margins, correct)
    return model, policy, round(thr, 6), info, train_s


def cmd_train(args, splits=None, man=None, register_as=None):
    if splits is None:
        splits, man = load_splits(SPLIT_DIR)
    v = args.variant
    model, policy, thr, thr_info, train_s = train_variant(v, splits)
    if model.kind == "majority":
        print("majority baseline is not serialised")
        return None
    version = f"{MODEL_VERSION_BASE}-{v}-{man['corpus_after_cleaning']['sha256'][:8]}"
    meta = {"model_version": version, "training_data_status": TRAINING_DATA_STATUS,
            "review_threshold": thr, "variant": v, "seed": SEED,
            "corpus_sha256": man["corpus_after_cleaning"]["sha256"],
            "train_split_sha256": man["splits"]["train"]["sha256"],
            "threshold_selection": thr_info}
    fname = f"{v}.json"
    path = os.path.join(art.MODEL_DIR, fname)
    sha = art.dump_artifact(model, policy, meta, path)
    reg_path = os.path.join(art.MODEL_DIR, art.REGISTRY_NAME)
    try:
        with open(reg_path, encoding="utf-8") as f:
            reg = json.load(f)
    except (OSError, ValueError):
        reg = {"default": None, "artifacts": {}}
    reg["artifacts"][v] = {"file": fname, "sha256": sha, "model_version": version,
                           "bytes": os.path.getsize(path),
                           "training_data_status": TRAINING_DATA_STATUS}
    if register_as == "default" or reg.get("default") is None:
        reg["default"] = v
    _json_dump(reg, reg_path)
    reset_cache()
    print(f"trained {v}: {version} sha256={sha[:12]} threshold={thr} ({train_s:.1f}s)")
    return model, policy, thr, meta


# ------------------------------------------------------------------ evaluate
SLICES = {
    "lang_ru": lambda r: r["language"] == "ru",
    "lang_kk": lambda r: r["language"] == "kk",
    "lang_mixed": lambda r: r["language"] == "mixed",
    "short_le_4_words": lambda r: len(r["text"].split()) <= 4,
    "kk_without_kazakh_letters": lambda r: "no_kk_letters" in r.get("tags", []),
    "ambiguous_by_annotator": lambda r: bool(r.get("ambiguous")),
    "source_template": lambda r: r["source"] == "synthetic_template",
    "source_handwritten": lambda r: r["source"] == "synthetic_handwritten",
}


def evaluate_records(payload, model, records):
    preds = [predict_with(payload, model, r["text"], None) for r in records]
    y_true = [r["label"] for r in records]
    y_pred = [p["label"] if p["status"] == "ok" else None for p in preds]
    out = prf(y_true, y_pred)
    out["confusion"] = confusion(y_true, y_pred)
    out["needs_review_rate"] = round(sum(p["needs_review"] for p in preds) / len(preds), 4) \
        if preds else None
    acc = [(t == p) for t, p, pr in zip(y_true, y_pred, preds) if not pr["needs_review"]]
    out["auto_accepted_n"] = len(acc)
    out["auto_accepted_accuracy"] = round(sum(acc) / len(acc), 4) if acc else None
    detected = {}
    for p in preds:
        detected[p["language"] or p["status"]] = detected.get(p["language"] or p["status"], 0) + 1
    out["detected_language_counts"] = detected
    slices = {}
    for name, fn in SLICES.items():
        idx = [i for i, r in enumerate(records) if fn(r)]
        if not idx:
            slices[name] = {"n": 0}
            continue
        s = prf([y_true[i] for i in idx], [y_pred[i] for i in idx])
        s.pop("per_class")
        s["needs_review_rate"] = round(sum(preds[i]["needs_review"] for i in idx) / len(idx), 4)
        slices[name] = s
    out["slices"] = slices
    errors = [{"id": r["id"], "true": t, "pred": p, "score": pr["score"],
               "needs_review": pr["needs_review"], "reasons": pr["review_reasons"],
               "language_annotated": r["language"], "language_used": pr["language"],
               "source": r["source"], "tags": r.get("tags", [])}
              for r, t, p, pr in zip(records, y_true, y_pred, preds) if t != p]
    return out, errors, preds


def _load_named(name):
    payload, model = art.load_artifact(None if name == "default" else name)
    return payload, model


def cmd_evaluate(args):
    splits, man = load_splits(SPLIT_DIR)
    payload, model = _load_named(args.artifact)
    res = {}
    for s in ("validation", "test"):
        m, errs, _ = evaluate_records(payload, model, splits[s])
        res[s] = m
        res[s + "_errors"] = errs
    print(json.dumps({s: {"n": res[s]["n"], "macro_f1": res[s]["macro_f1"],
                          "accuracy": res[s]["accuracy"]} for s in ("validation", "test")},
                     ensure_ascii=False))
    return res


# ------------------------------------------------------------------ experiment
def cmd_experiment(args):
    splits, man = load_splits(SPLIT_DIR)
    rows, all_metrics = [], {}
    trained = {}
    for v in VARIANTS:
        model, policy, thr, thr_info, train_s = train_variant(v, splits)
        payload = _payload(model, policy, thr, f"{MODEL_VERSION_BASE}-{v}")
        val, _, _ = evaluate_records(payload, model, splits["validation"])
        trained[v] = (model, policy, thr, thr_info, train_s, payload, val)
    # choose shipped model on VALIDATION macro-F1 only (ties -> simpler model order)
    candidates = [v for v in VARIANTS if v != "majority"]
    chosen = max(candidates, key=lambda v: (trained[v][6]["macro_f1"] or 0,
                                            -candidates.index(v)))
    errors_by_variant = {}
    for v in VARIANTS:
        model, policy, thr, thr_info, train_s, payload, val = trained[v]
        test, errs, _ = evaluate_records(payload, model, splits["test"])
        errors_by_variant[v] = errs
        stripped = [dict(r, text=kk_fold(normalize(r["text"]))) for r in splits["test"]
                    if r["language"] == "kk"]
        test["stress_kk_without_kazakh_letters"] = {
            k: x for k, x in evaluate_records(payload, model, stripped)[0].items()
            if k in ("n", "accuracy", "macro_f1", "needs_review_rate",
                     "detected_language_counts")}
        all_metrics[v] = {"validation": val, "test": test, "review_threshold": thr,
                          "threshold_selection": thr_info, "feature_policy": policy,
                          "train_seconds": round(train_s, 2),
                          "vocab_size": getattr(model, "vocab_size", 0)}
        rows.append({
            "variant": v, "role": ("baseline" if v == BASELINE else
                                   "sanity" if v == "majority" else "candidate"),
            "val_macro_f1": val["macro_f1"], "test_macro_f1": test["macro_f1"],
            "test_acc": test["accuracy"],
            "test_template_macro_f1": test["slices"]["source_template"].get("macro_f1"),
            "test_handwritten_macro_f1": test["slices"]["source_handwritten"].get("macro_f1"),
            "test_kk_macro_f1": test["slices"]["lang_kk"].get("macro_f1"),
            "test_ru_macro_f1": test["slices"]["lang_ru"].get("macro_f1"),
            "test_no_kk_letters_acc": test["slices"]["kk_without_kazakh_letters"].get("accuracy"),
            "stress_kk_stripped_macro_f1": test["stress_kk_without_kazakh_letters"]["macro_f1"],
            "test_needs_review_rate": test["needs_review_rate"],
            "test_auto_accepted_acc": test["auto_accepted_accuracy"],
            "review_threshold": thr,
        })
    # register artifacts for baseline and chosen candidate
    for v in sorted({BASELINE, chosen}):
        a = argparse.Namespace(variant=v)
        cmd_train(a, splits, man, register_as="default" if v == chosen else None)
    return {"rows": rows, "chosen": chosen, "metrics": all_metrics,
            "errors": errors_by_variant, "manifest": man}


def write_experiment_outputs(exp):
    os.makedirs(RESULTS_DIR, exist_ok=True)
    man = exp["manifest"]
    metrics = {
        "schema": "civic-r08-metrics-v1",
        "metrics_kind": "DEMONSTRATION_ON_SYNTHETIC_DATA",
        "warning": "All numbers below are computed on author-written synthetic messages "
                   "(template-generated + handwritten). They demonstrate that the pipeline "
                   "works; they are NOT estimates of quality on real citizen messages.",
        "real_data_metrics": {"status": "NOT_RUN",
                              "reason": "no permitted, de-identified real corpus available",
                              "macro_f1": None, "per_class": None},
        "corpus_sha256": man["corpus_after_cleaning"]["sha256"],
        "split_sizes": {s: man["splits"][s]["n"] for s in SPLITS},
        "test_composition": {"by_language": man["splits"]["test"]["by_language"],
                             "by_label": man["splits"]["test"]["by_label"],
                             "by_source": man["splits"]["test"]["by_source"]},
        "seed": SEED,
        "selection_rule": "shipped default = highest validation macro-F1 (test not used)",
        "shipped_default": exp["chosen"],
        "baseline": BASELINE,
        "comparison": exp["rows"],
        "variants": exp["metrics"],
        "second_experiment_multilingual_encoder": {
            "status": "NOT_RUN",
            "reason": "no permitted real corpus; synthetic template data would make "
                      "fine-tuning results meaningless; no torch/transformers installed, CPU "
                      "only; downloading model weights not justified for this corpus"},
        "environment": {"python": platform.python_version(), "platform": platform.platform(),
                        "dependencies": "python stdlib only"},
    }
    _json_dump(metrics, os.path.join(RESULTS_DIR, "metrics.json"))
    errs = {v: e for v, e in exp["errors"].items() if v in (BASELINE, exp["chosen"])}
    _json_dump({"note": "Test-split errors (ids refer to synthetic records in "
                        "ml/civic_classifier/data/splits/test.jsonl).", "errors": errs},
               os.path.join(RESULTS_DIR, "test_errors.json"))
    # markdown-free plain comparison table
    cols = ["variant", "role", "val_macro_f1", "test_macro_f1", "test_template_macro_f1",
            "test_handwritten_macro_f1", "test_ru_macro_f1", "test_kk_macro_f1",
            "test_no_kk_letters_acc", "stress_kk_stripped_macro_f1", "test_needs_review_rate", "test_auto_accepted_acc",
            "review_threshold"]
    lines = ["COMPARISON (synthetic data, demonstration only; test n=%d)"
             % man["splits"]["test"]["n"], "\t".join(cols)]
    for r in exp["rows"]:
        lines.append("\t".join("" if r[c] is None else str(r[c]) for c in cols))
    lines.append("multilingual_encoder_finetune\tcandidate-2\tNOT_RUN (see metrics.json)")
    with open(os.path.join(RESULTS_DIR, "comparison.tsv"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    # train / evaluation manifests
    reg = art.read_registry()
    _json_dump({
        "schema": "civic-r08-train-manifest-v1",
        "command": "python -m ml.civic_classifier.cli build-data && "
                   "python -m ml.civic_classifier.cli experiment",
        "seed": SEED, "python": platform.python_version(), "dependencies": "stdlib only",
        "corpus_sha256": man["corpus_after_cleaning"]["sha256"],
        "split_manifest_sha256": _file_sha(os.path.join(SPLIT_DIR, "split_manifest.json")),
        "variants": {v: {"feature_policy": exp["metrics"][v]["feature_policy"],
                         "review_threshold": exp["metrics"][v]["review_threshold"],
                         "threshold_selection": exp["metrics"][v]["threshold_selection"],
                         "train_seconds": exp["metrics"][v]["train_seconds"],
                         "vocab_size": exp["metrics"][v]["vocab_size"]}
                     for v in VARIANTS},
        "hyperparameters": {"nb": {"alpha": 0.5, "min_df": 2},
                            "softmax": {"epochs": 12, "lr": 0.5, "l2": 1e-4, "min_df": 2,
                                        "seed": SEED % 1000, "tf": "l2-normalised counts"}},
        "registry": reg,
    }, os.path.join(RESULTS_DIR, "train_manifest.json"))
    _json_dump({
        "schema": "civic-r08-evaluation-manifest-v1",
        "command": "python -m ml.civic_classifier.cli experiment",
        "evaluated_on": {s: {"n": man["splits"][s]["n"], "sha256": man["splits"][s]["sha256"]}
                         for s in ("validation", "test")},
        "language_passed_to_classify": None,
        "language_note": "evaluation calls classify logic with language=None (auto-detect), "
                         "as a caller without a language field would",
        "slices": list(SLICES),
        "metrics_file": "metrics.json", "errors_file": "test_errors.json",
        "real_data_evaluation": "NOT_RUN",
    }, os.path.join(RESULTS_DIR, "evaluation_manifest.json"))


# ------------------------------------------------------------------ misc
def cmd_predict(args):
    from .classify import classify
    print(json.dumps(classify(args.text, args.language), ensure_ascii=False, indent=2))


def cmd_active_review(args):
    """List uncertain validation/test items by id + text hash only (no text)."""
    splits, _ = load_splits(SPLIT_DIR)
    payload, model = _load_named("default")
    rows = []
    for s in ("validation", "test"):
        for r in splits[s]:
            p = predict_with(payload, model, r["text"], None)
            if p["needs_review"]:
                rows.append({"split": s, "id": r["id"],
                             "text_sha256_12": hashlib.sha256(r["text"].encode()).hexdigest()[:12],
                             "suggested": p["label"], "alternatives": p["alternatives"],
                             "score": p["score"], "reasons": p["review_reasons"]})
    rows.sort(key=lambda x: (x["score"] if x["score"] is not None else -1))
    out = {"note": "Ids and hashes only; resolve text from the access-controlled corpus.",
           "model_version": payload["model_version"], "n": len(rows), "items": rows}
    path = args.out or os.path.join(RESULTS_DIR, "active_review.json")
    _json_dump(out, path)
    print(f"{len(rows)} uncertain items -> {path}")


def cmd_export_annotation(args):
    """CSV for future manual labelling. Reads a JSONL of {id,text[,language]} records."""
    src = args.input
    rows = []
    with open(src, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    payload, model = _load_named("default")
    with open(args.out, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "text", "language", "model_suggestion", "model_score_uncalibrated",
                    "needs_review", "annotator_label", "annotator_id", "ambiguous", "comment"])
        for r in rows:
            p = predict_with(payload, model, r["text"], r.get("language"))
            w.writerow([r["id"], r["text"], p["language"] or "", p["label"] or "",
                        "" if p["score"] is None else p["score"], p["needs_review"],
                        "", "", "", ""])
    print(f"wrote {len(rows)} rows -> {args.out} (labels allowed: {', '.join(LABELS)})")


def cmd_bench(args):
    splits, _ = load_splits(SPLIT_DIR)
    texts = [r["text"] for r in splits["test"]]
    out = {"machine": {"platform": platform.platform(), "processor": platform.processor(),
                       "python": platform.python_version(), "cpu_count": os.cpu_count()}}
    for name in ("default", BASELINE):
        reset_cache()
        t0 = time.perf_counter()
        payload, model = _load_named(name)
        load_s = time.perf_counter() - t0
        t0 = time.perf_counter()
        for _ in range(args.repeat):
            for t in texts:
                predict_with(payload, model, t, None)
        n = len(texts) * args.repeat
        per = (time.perf_counter() - t0) / n
        out[name] = {"model_version": payload["model_version"], "load_seconds": round(load_s, 3),
                     "mean_ms_per_message": round(per * 1000, 3), "messages": n}
    _json_dump(out, os.path.join(RESULTS_DIR, "inference_benchmark.json"))
    print(json.dumps(out, ensure_ascii=False, indent=2))


# ------------------------------------------------------------------ grouped CV
def template_folds(records, k=6, seed=SEED):
    """Fold i holds out the i-th template (after seeded shuffle) of every
    (language, label) pair. Handwritten records are never trained on."""
    import random
    from collections import defaultdict
    rng = random.Random(seed)
    by = defaultdict(set)
    for r in records:
        if r["source"] == "synthetic_template":
            by[(r["language"], r["label"])].add(r["group"])
    order = {}
    for key in sorted(by):
        g = sorted(by[key])
        rng.shuffle(g)
        order[key] = g
    folds = []
    for i in range(k):
        held = {g[i] for g in order.values() if i < len(g)}
        folds.append(held)
    return folds


def cmd_cv(args):
    import statistics
    splits, man = load_splits(SPLIT_DIR)
    allrecs = [r for s in SPLITS for r in splits[s]]
    tmpl = [r for r in allrecs if r["source"] == "synthetic_template"]
    hw = [r for r in allrecs if r["source"] == "synthetic_handwritten"]
    variants = [v for v in VARIANTS if v != "majority"]
    folds = template_folds(tmpl, k=args.folds)
    per_fold = []
    for i, held in enumerate(folds):
        train = [r for r in tmpl if r["group"] not in held]
        test = [r for r in tmpl if r["group"] in held]
        verify_no_leakage({"train": train, "validation": [], "test": test + hw})
        row = {"fold": i, "n_train": len(train), "n_test_template": len(test),
               "n_handwritten": len(hw), "held_out_templates": sorted(held)}
        for v in variants:
            policy = _policy(v)
            model = _make_model(VARIANTS[v]["model"])
            model.fit([extract(r["text"], policy) for r in train], [r["label"] for r in train])
            payload = _payload(model, policy, 0.0, v)
            mt, _, _ = evaluate_records(payload, model, test)
            mh, _, _ = evaluate_records(payload, model, hw)
            row[v] = {"template_macro_f1": mt["macro_f1"], "handwritten_macro_f1": mh["macro_f1"],
                      "template_ru_macro_f1": mt["slices"]["lang_ru"].get("macro_f1"),
                      "template_kk_macro_f1": mt["slices"]["lang_kk"].get("macro_f1")}
        per_fold.append(row)
        print(f"fold {i}: " + ", ".join(f"{v}={row[v]['template_macro_f1']}" for v in variants))

    def agg(v, key):
        xs = [f[v][key] for f in per_fold if f[v][key] is not None]
        return {"mean": round(statistics.mean(xs), 4),
                "std": round(statistics.stdev(xs), 4) if len(xs) > 1 else None,
                "min": min(xs), "max": max(xs), "folds": len(xs)}
    summary = {v: {k: agg(v, k) for k in ("template_macro_f1", "handwritten_macro_f1",
                                          "template_ru_macro_f1", "template_kk_macro_f1")}
               for v in variants}
    paired = {}
    for v in variants:
        if v == BASELINE:
            continue
        d = [f[v]["template_macro_f1"] - f[BASELINE]["template_macro_f1"] for f in per_fold]
        paired[f"{v}_minus_{BASELINE}"] = {
            "mean_diff": round(statistics.mean(d), 4),
            "std_diff": round(statistics.stdev(d), 4) if len(d) > 1 else None,
            "folds_candidate_better": sum(1 for x in d if x > 0), "folds": len(d)}
    out = {"schema": "civic-r08-grouped-cv-v1",
           "metrics_kind": "DEMONSTRATION_ON_SYNTHETIC_DATA",
           "method": f"{args.folds}-fold leave-templates-out: fold i holds out the i-th template "
                     "of every (language,label) pair; handwritten set (never trained) evaluated "
                     "in every fold; leakage verified per fold; no threshold (labels only)",
           "seed": SEED, "corpus_sha256": man["corpus_after_cleaning"]["sha256"],
           "summary": summary, "paired_vs_baseline": paired, "per_fold": per_fold,
           "caveat": "Folds share slot fillers (places, greetings) across train/test by design; "
                     "the only unseen element is the template core phrasing. Small number of "
                     "folds -> std is itself uncertain."}
    _json_dump(out, os.path.join(RESULTS_DIR, "cv_results.json"))
    print(json.dumps({"summary": summary, "paired": paired}, ensure_ascii=False, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="civic_classifier")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("build-data")
    p.add_argument("--per-template", type=int, default=30)
    p = sub.add_parser("train")
    p.add_argument("--variant", choices=[v for v in VARIANTS if v != "majority"],
                   default=BASELINE)
    p = sub.add_parser("evaluate")
    p.add_argument("--artifact", default="default")
    sub.add_parser("experiment")
    p = sub.add_parser("cv")
    p.add_argument("--folds", type=int, default=6)
    p = sub.add_parser("predict")
    p.add_argument("text")
    p.add_argument("--language", default=None)
    p = sub.add_parser("active-review")
    p.add_argument("--out", default=None)
    p = sub.add_parser("export-annotation")
    p.add_argument("--input", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("bench")
    p.add_argument("--repeat", type=int, default=3)
    a = ap.parse_args(argv)
    if a.cmd == "build-data":
        cmd_build_data(a)
    elif a.cmd == "train":
        cmd_train(a)
    elif a.cmd == "evaluate":
        cmd_evaluate(a)
    elif a.cmd == "experiment":
        exp = cmd_experiment(a)
        write_experiment_outputs(exp)
        print("chosen default:", exp["chosen"])
        for r in exp["rows"]:
            print(r)
    elif a.cmd == "cv":
        cmd_cv(a)
    elif a.cmd == "predict":
        cmd_predict(a)
    elif a.cmd == "active-review":
        cmd_active_review(a)
    elif a.cmd == "export-annotation":
        cmd_export_annotation(a)
    elif a.cmd == "bench":
        cmd_bench(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
