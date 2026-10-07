"""Честный протокол сравнения раунда 13 (research/round-13-results/R08/PROTOCOL.md).

    python -m ml.civic_classifier protocol --sets cv,test,probe   # разработка/exploratory
    python -m ml.civic_classifier protocol --sets challenge       # один раз, замороженный набор

Методы: keyword (эвристика), logreg (n-граммы), hybrid (logreg + словарь), nb, hybrid+abstain.
Гиперпараметры — выбранные в раунде 12 по validation; здесь ничего не подбирается.
"""

from __future__ import annotations

import hashlib
import json
import statistics
from pathlib import Path

from ml.civic_classifier.abstain import load_policy, reasons
from ml.civic_classifier.corpus import CORPUS_PATH, load_corpus, sha256_file
from ml.civic_classifier.heuristic import heuristic_label, keyword_hits
from ml.civic_classifier.labels import LABELS
from ml.civic_classifier.metrics import classification_report
from ml.civic_classifier.model import load_model, predict_scores
from ml.civic_classifier.train import (FEATURE_PARAMS, KW_FEATURES, SEED, _model_dict, _raw, build_vocab, train_lr,
                                       train_nb)

DATA = CORPUS_PATH.parent
CHALLENGE = DATA / "challenge_r13_v1.jsonl"
CHALLENGE_FREEZE = DATA / "challenge_r13_v1.freeze.json"
PROBE = DATA / "probe_agent_v1.jsonl"
FOLDS = 5
LR_PLAIN = {"l2": 1e-5, "epochs": 24, "lr0": 0.5}            # лучшая «чистая» logreg раунда 12 по validation
HYBRID = {"l2": 1e-4, "epochs": 12, "lr0": 0.5, "keyword_scale": 1.0}   # выбранный гибрид раунда 12
NB_ALPHA = 0.1                                               # лучший NB раунда 12 по validation
CONFIDENT = 0.9
METHODS = ("keyword", "logreg", "hybrid", "nb", "hybrid+abstain")


def family(r: dict) -> str:
    return f'{r["label"]}/{r["family"]}'


def family_folds(rows: list[dict], k: int = FOLDS) -> dict[str, int]:
    """Группа = (метка, семейство). Внутри метки — порядок sha256(seed:группа), затем по кругу со сдвигом."""
    by_label: dict[str, set] = {}
    for r in rows:
        by_label.setdefault(r["label"], set()).add(family(r))
    out = {}
    for li, label in enumerate(LABELS):
        fams = sorted(by_label.get(label, ()), key=lambda f: hashlib.sha256(f"{SEED}:{f}".encode()).hexdigest())
        for j, f in enumerate(fams):
            out[f] = (j + li) % k
    return out


def train_models(rows: list[dict], corpus_sha: str = "cv", split_sha: str = "cv") -> dict:
    texts = [r["text"] for r in rows]
    raw = _raw(texts)
    y = [LABELS.index(r["label"]) for r in rows]
    vocab = build_vocab(raw)
    nb = _model_dict("nb", vocab, train_nb(raw, y, vocab, NB_ALPHA), {"alpha": NB_ALPHA}, corpus_sha, split_sha)
    lr = _model_dict("logreg", vocab, train_lr(raw, y, vocab, **LR_PLAIN), LR_PLAIN, corpus_sha, split_sha)
    vocab_kw = sorted(set(vocab) | set(KW_FEATURES))
    fp = dict(FEATURE_PARAMS, keyword_features=True, keyword_scale=HYBRID["keyword_scale"])
    lr_h = {k: v for k, v in HYBRID.items() if k != "keyword_scale"}
    hy = _model_dict("logreg", vocab_kw, train_lr(raw, y, vocab_kw, **lr_h, texts=texts,
                                                   keyword_scale=HYBRID["keyword_scale"]), HYBRID, corpus_sha,
                     split_sha, feature_params=fp)
    for m in (nb, lr, hy):
        m["_index"] = {f: i for i, f in enumerate(m["features"])}
    return {"logreg": lr, "hybrid": hy, "nb": nb}


def predict_all(models: dict, rows: list[dict], margin: float) -> dict[str, list[dict]]:
    out = {m: [] for m in METHODS}
    for r in rows:
        t = r["text"]
        lab, hits = heuristic_label(t)
        out["keyword"].append({"pred": lab, "score": None, "confident": hits >= 2, "abstain": False})
        for name in ("logreg", "hybrid", "nb"):
            p = predict_scores(t, models[name])
            k = max(range(len(LABELS)), key=lambda j: (p[j], -j))
            out[name].append({"pred": LABELS[k], "score": round(p[k], 4), "confident": p[k] >= CONFIDENT,
                              "abstain": False})
            if name == "hybrid":
                why = reasons(t, p, margin)
                out["hybrid+abstain"].append({"pred": LABELS[k], "score": round(p[k], 4),
                                              "confident": p[k] >= CONFIDENT, "abstain": bool(why), "reasons": why})
    return out


def summarize(rows: list[dict], preds: list[dict], slice_keys=("language",)) -> dict:
    y = [LABELS.index(r["label"]) for r in rows]
    yp = [LABELS.index(p["pred"]) for p in preds]
    rep = classification_report(y, yp)
    accepted = [i for i, p in enumerate(preds) if not p["abstain"]]
    correct_acc = [i for i in accepted if preds[i]["pred"] == rows[i]["label"]]
    conf_err = [i for i in accepted if preds[i]["confident"] and preds[i]["pred"] != rows[i]["label"]]
    safe = 0
    for r, p in zip(rows, preds):
        ok = {r["label"], *r.get("also_labels", [])}
        safe += 1 if (p["abstain"] or p["pred"] in ok) else 0
    out = {"n": len(rows), "accuracy_all": rep["accuracy"], "macro_f1_all": rep["macro_f1"],
           "per_class": rep["per_class"], "confusion": rep["confusion"],
           "coverage": round(len(accepted) / len(rows), 4) if rows else None,
           "accuracy_accepted": round(len(correct_acc) / len(accepted), 4) if accepted else None,
           "confident_errors": len(conf_err), "safe_outcome_rate": round(safe / len(rows), 4) if rows else None,
           "slices": {}}
    for key in slice_keys:
        groups: dict[str, list[int]] = {}
        for i, r in enumerate(rows):
            vals = r.get(key)
            for v in (vals if isinstance(vals, list) else [vals]):
                groups.setdefault(str(v), []).append(i)
        out["slices"][key] = {}
        for v, idx in sorted(groups.items()):
            sub = classification_report([y[i] for i in idx], [yp[i] for i in idx])
            acc_idx = [i for i in idx if not preds[i]["abstain"]]
            out["slices"][key][v] = {
                "n": len(idx), "accuracy": sub["accuracy"], "macro_f1": sub["macro_f1"],
                "coverage": round(len(acc_idx) / len(idx), 4),
                "safe_outcome_rate": round(sum(1 for i in idx if preds[i]["abstain"] or preds[i]["pred"] in
                                               {rows[i]["label"], *rows[i].get("also_labels", [])}) / len(idx), 4)}
    return out


def run_cv(margin: float) -> dict:
    rows, man = load_corpus()
    rows = [r for r in rows if r["split"] != "excluded_near_dup"]
    folds = family_folds(rows)
    per_fold, pooled = [], {m: [None] * len(rows) for m in METHODS}
    for k in range(FOLDS):
        tr = [r for r in rows if folds[family(r)] != k]
        te_idx = [i for i, r in enumerate(rows) if folds[family(r)] == k]
        models = train_models(tr)
        preds = predict_all(models, [rows[i] for i in te_idx], margin)
        row = {"fold": k, "train_rows": len(tr), "test_rows": len(te_idx),
               "test_families": len({family(rows[i]) for i in te_idx})}
        for m in METHODS:
            for i, p in zip(te_idx, preds[m]):
                pooled[m][i] = p
            s = summarize([rows[i] for i in te_idx], preds[m], slice_keys=())
            row[m] = {"macro_f1": s["macro_f1_all"], "accuracy": s["accuracy_all"], "coverage": s["coverage"],
                      "accuracy_accepted": s["accuracy_accepted"]}
        per_fold.append(row)
        print(f"fold {k}: " + ", ".join(f"{m}={row[m]['macro_f1']}" for m in METHODS), flush=True)
    result = {"protocol": "leave-family-out CV", "folds": FOLDS, "groups": len(folds), "rows": len(rows),
              "corpus_sha256": man["corpus_sha256"], "fold_of_group": folds, "per_fold": per_fold,
              "pooled": {m: summarize(rows, pooled[m], slice_keys=("language", "short", "ambiguous"))
                         for m in METHODS}}
    spread = {}
    for m in METHODS:
        xs = [f[m]["macro_f1"] for f in per_fold]
        spread[m] = {"mean": round(statistics.mean(xs), 4), "min": min(xs), "max": max(xs),
                     "stdev": round(statistics.stdev(xs), 4)}
    paired = {}
    for m in ("logreg", "hybrid", "nb"):
        d = [f[m]["macro_f1"] - f["keyword"]["macro_f1"] for f in per_fold]
        paired[f"{m}_minus_keyword"] = {"per_fold": [round(x, 4) for x in d], "mean": round(statistics.mean(d), 4),
                                        "folds_better": sum(1 for x in d if x > 0), "folds": len(d)}
    result["macro_f1_over_folds"] = spread
    result["paired_vs_keyword"] = paired
    result["note"] = ("5 фолдов по 56 группам происхождения; разброс по фолдам, а не доверительный интервал. "
                      "Синтетика одного автора: перенос на реальные обращения не следует.")
    return result


def run_fixed(names: list[str], margin: float) -> dict:
    """Модели, обученные на train split раунда 12; оценка на test/probe/challenge."""
    rows, man = load_corpus()
    pinned_h = load_model()
    pinned_nb = load_model(DATA / "model_alt_nb.json.gz")
    tr = [r for r in rows if r["split"] == "train"]
    plain = train_models(tr, man["corpus_sha256"], sha256_file(DATA / "split_v2.json"))["logreg"]
    models = {"hybrid": pinned_h, "nb": pinned_nb, "logreg": plain}
    out = {"models": {"hybrid": pinned_h["version"] + " (pinned model.json.gz, payload " + pinned_h["payload_sha256"][:12] + ")",
                      "nb": pinned_nb["version"] + " (pinned model_alt_nb.json.gz)",
                      "logreg": "retrained on round-12 train split with " + json.dumps(LR_PLAIN),
                      "keyword": "heuristic.py STEMS (unchanged since a26e598)"},
           "abstain_margin": margin}
    sets = {}
    if "test" in names:
        sets["test_r12_exploratory"] = [r for r in rows if r["split"] == "test"]
    if "probe" in names:
        sets["probe_r12_exploratory"] = [json.loads(x) for x in PROBE.read_text(encoding="utf-8").splitlines() if x.strip()]
    if "challenge" in names:
        freeze = json.loads(CHALLENGE_FREEZE.read_text(encoding="utf-8"))
        actual = hashlib.sha256(CHALLENGE.read_bytes()).hexdigest()
        if actual != freeze["sha256"]:
            raise SystemExit("challenge file differs from its freeze record — not a valid final check")
        sets["challenge_r13_v1"] = [json.loads(x) for x in CHALLENGE.read_text(encoding="utf-8").splitlines() if x.strip()]
        out["challenge_sha256"] = actual
    for name, rs in sets.items():
        preds = predict_all(models, rs, margin)
        keys = ("language", "phenomena") if name.startswith("challenge") else ("language", "short", "ambiguous", "style")
        out[name] = {m: summarize(rs, preds[m], slice_keys=keys) for m in METHODS}
        out[name]["errors_hybrid_abstain"] = [
            {"id": r["id"], "text": r["text"], "label": r["label"], "also": r.get("also_labels", []),
             "pred": p["pred"], "score": p["score"], "abstain": p["abstain"], "reasons": p.get("reasons", []),
             "keyword_pred": kp["pred"], "language": r.get("language"), "phenomena": r.get("phenomena", r.get("style"))}
            for r, p, kp in zip(rs, preds["hybrid+abstain"], preds["keyword"])
            if p["pred"] not in {r["label"], *r.get("also_labels", [])}]
    return out


def run(sets: list[str], out_dir: Path) -> dict:
    policy = load_policy()
    margin = policy["margin_threshold"]
    result = {"schema": "civic-r08-protocol-v1", "policy": {k: policy[k] for k in ("version", "margin_threshold")},
              "hyper": {"logreg": LR_PLAIN, "hybrid": HYBRID, "nb_alpha": NB_ALPHA}, "confident_score": CONFIDENT,
              "evidence": "synthetic/agent-labeled only; real_data_NOT_EVALUATED"}
    if "cv" in sets:
        result["cv"] = run_cv(margin)
    fixed = [s for s in sets if s in ("test", "probe", "challenge")]
    if fixed:
        result["fixed"] = run_fixed(fixed, margin)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = "protocol_challenge.json" if sets == ["challenge"] else "protocol_dev.json"
    (out_dir / name).write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return result
