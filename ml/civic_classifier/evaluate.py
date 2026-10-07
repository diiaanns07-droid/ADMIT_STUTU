"""Оценка сохранённой модели (без переобучения): test (невиданные шаблоны), пробный набор агента,
сравнение с NB и эвристикой, срезы, близкие дубликаты, калибровка, порог, время/память.

ВСЕ метрики — на СИНТЕТИЧЕСКИХ/агентских данных (демонстрационные). Качество на реальных обращениях:
NOT_EVALUATED. Validation здесь только для справки: на нём выбирались метод и порог.
"""

from __future__ import annotations

import json
import random
import time
import tracemalloc
from pathlib import Path

from ml.civic_classifier.corpus import DATA_DIR, _grams, load_corpus, max_similarity
from ml.civic_classifier.heuristic import heuristic_label
from ml.civic_classifier.labels import LABELS
from ml.civic_classifier.metrics import bootstrap_macro_f1, classification_report, ece
from ml.civic_classifier.model import DEFAULT_MODEL_PATH, load_model, predict_scores

PROBE_PATH = DATA_DIR / "probe_agent_v1.jsonl"
SELECTED = "{kind}{kw} (selected)"
DEMO_NOTE = "DEMONSTRATION: synthetic/agent-authored data; real-data quality NOT_EVALUATED"
TEST_LOOK = ("experiment 2: test viewed for the 2nd time (experiment 1 = plain logreg, see exp1/); "
             "selection still on validation only")


def _load_probe():
    return [json.loads(x) for x in PROBE_PATH.read_text(encoding="utf-8").splitlines() if x.strip()]


def _predict(model, texts):
    out = []
    for t in texts:
        p = predict_scores(t, model)
        k = max(range(len(LABELS)), key=lambda j: (p[j], -j))
        out.append((k, p[k]))
    return out


def cluster_bootstrap(y, pred, groups, n_boot=1000, seed=20261007) -> dict:
    """Бутстрэп по шаблонам: ошибки внутри шаблона коррелируют, поэтому ресэмплируются шаблоны целиком."""
    by_group: dict[str, list[int]] = {}
    for i, g in enumerate(groups):
        by_group.setdefault(g, []).append(i)
    keys = sorted(by_group)
    rng = random.Random(seed)
    vals = []
    for _ in range(n_boot):
        idx = [i for g in (rng.choice(keys) for _ in keys) for i in by_group[g]]
        vals.append(classification_report([y[i] for i in idx], [pred[i] for i in idx])["macro_f1"] or 0.0)
    vals.sort()
    return {"low": round(vals[int(0.025 * n_boot)], 4), "high": round(vals[int(0.975 * n_boot) - 1], 4),
            "n_boot": n_boot, "level": 0.95, "unit": f"template clusters (n={len(keys)})"}


def paired_delta(y, pred_a, pred_b, groups=None, n_boot=1000, seed=20261007) -> dict:
    """Парный бутстрэп разницы macro-F1 (a − b) на одних и тех же ресэмплах (кластеры = шаблоны)."""
    units: dict = {}
    for i in range(len(y)):
        units.setdefault(groups[i] if groups else i, []).append(i)
    keys = sorted(units, key=str)
    rng = random.Random(seed)
    deltas = []
    for _ in range(n_boot):
        idx = [i for g in (rng.choice(keys) for _ in keys) for i in units[g]]
        ya = [y[i] for i in idx]
        fa = classification_report(ya, [pred_a[i] for i in idx])["macro_f1"] or 0.0
        fb = classification_report(ya, [pred_b[i] for i in idx])["macro_f1"] or 0.0
        deltas.append(fa - fb)
    deltas.sort()
    point = (classification_report(y, pred_a)["macro_f1"] or 0) - (classification_report(y, pred_b)["macro_f1"] or 0)
    return {"delta": round(point, 4), "low": round(deltas[int(0.025 * n_boot)], 4),
            "high": round(deltas[int(0.975 * n_boot) - 1], 4), "share_boot_delta_gt_0": round(
                sum(1 for d in deltas if d > 0) / n_boot, 3), "unit": "template clusters" if groups else "items"}


def _report(y, pred, groups=None):
    rep = classification_report(y, pred)
    rep["ci_macro_f1"] = cluster_bootstrap(y, pred, groups) if groups else bootstrap_macro_f1(y, pred)
    return rep


def _slices(rows, y, pred, key_fn):
    out = {}
    for name in sorted({key_fn(r) for r in rows}):
        idx = [i for i, r in enumerate(rows) if key_fn(r) == name]
        if idx:
            rep = classification_report([y[i] for i in idx], [pred[i] for i in idx])
            out[str(name)] = {"n": len(idx), "accuracy": rep["accuracy"], "macro_f1": rep["macro_f1"]}
    return out


def _threshold_effect(scored, y, thr):
    acc = [(k == yy) for (k, s), yy in zip(scored, y) if s >= thr and LABELS[k] != "other"]
    return {"threshold": thr, "auto_share": round(len(acc) / len(y), 4) if y else None,
            "precision_auto": round(sum(acc) / len(acc), 4) if acc else None,
            "note": "что дал бы порог, если бы ему доверяли; в runtime для синтетической модели needs_review=True всегда"}


def _perf(texts) -> dict:
    tracemalloc.start()
    t0 = time.perf_counter()
    model = load_model()
    load_s = time.perf_counter() - t0
    _, peak_load = tracemalloc.get_traced_memory()
    lat = []
    for t in texts:
        t1 = time.perf_counter()
        predict_scores(t, model)
        lat.append((time.perf_counter() - t1) * 1000)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    lat.sort()
    return {"model_file_bytes": DEFAULT_MODEL_PATH.stat().st_size, "load_seconds": round(load_s, 3),
            "peak_python_alloc_mb_load": round(peak_load / 2 ** 20, 1), "peak_python_alloc_mb": round(peak / 2 ** 20, 1),
            "classify_ms_mean": round(sum(lat) / len(lat), 3), "classify_ms_p95": round(lat[int(0.95 * len(lat)) - 1], 3),
            "n": len(lat), "note": "одно ядро CPU, CPython, без GPU/сети; время — в этой облачной среде"}


def evaluate(out_dir: Path) -> dict:
    rows, manifest = load_corpus()
    model = load_model()
    alt_path = next(DEFAULT_MODEL_PATH.parent.glob("model_alt_*.json.gz"), None)
    alt = load_model(alt_path) if alt_path else None
    train_rows = [r for r in rows if r["split"] == "train"]
    sets = {"test": [r for r in rows if r["split"] == "test"], "probe": _load_probe(),
            "val_reference_only": [r for r in rows if r["split"] == "val"]}
    train_g = [_grams(r["text"]) for r in train_rows]
    results = {"note": DEMO_NOTE, "test_look": TEST_LOOK, "model_version": model["version"], "model_kind": model["kind"],
               "keyword_features": bool(model["feature_params"].get("keyword_features")),
               "alt_model": alt["version"] if alt else None, "corpus_sha256": manifest["corpus_sha256"],
               "threshold_from_validation": model["threshold"], "sets": {}}
    failures = []
    for name, data in sets.items():
        y = [LABELS.index(r["label"]) for r in data]
        groups = [r["template_id"] for r in data] if "template_id" in data[0] else None
        scored = _predict(model, [r["text"] for r in data])
        pred = [k for k, _ in scored]
        heur = [LABELS.index(heuristic_label(r["text"])[0]) for r in data]
        entry = {"n": len(data), "methods": {
            SELECTED.format(kind=model["kind"], kw="+keywords" if model["feature_params"].get("keyword_features") else ""):
                _report(y, pred, groups),
            "keyword_heuristic": _report(y, heur, groups)}}
        if alt:
            entry["methods"][f"{alt['kind']} (alternative)"] = _report(y, [k for k, _ in _predict(alt, [r["text"] for r in data])], groups)
        entry["paired_delta_selected_minus_heuristic"] = paired_delta(y, pred, heur, groups)
        sims = max_similarity([_grams(r["text"]) for r in data], train_g)
        entry["slices_selected"] = {
            "language": _slices(data, y, pred, lambda r: r["language"]),
            "short_le_3_words": _slices(data, y, pred, lambda r: len(r["text"].split()) <= 3),
            "ambiguous": _slices(data, y, pred, lambda r: bool(r.get("ambiguous"))),
            "max_train_jaccard": _slices([dict(r, _s=s) for r, s in zip(data, sims)], y, pred,
                                         lambda r: "<0.4" if r["_s"] < 0.4 else "0.4-0.6" if r["_s"] < 0.6 else ">=0.6"),
        }
        entry["slices_heuristic"] = {"language": _slices(data, y, heur, lambda r: r["language"])}
        if name == "probe":
            entry["slices_selected"]["style"] = _slices(data, y, pred, lambda r: r["style"])
            entry["slices_heuristic"]["style"] = _slices(data, y, heur, lambda r: r["style"])
        entry["near_duplicates"] = {"max_train_jaccard_mean": round(sum(sims) / len(sims), 3),
                                    "share_ge_0.6": round(sum(1 for s in sims if s >= 0.6) / len(sims), 3)}
        entry["calibration_ece_selected"] = ece([int(k == yy) for (k, _), yy in zip(scored, y)], [s for _, s in scored])
        entry["threshold_effect"] = _threshold_effect(scored, y, model["threshold"])
        results["sets"][name] = entry
        if name == "probe":
            for r, (k, s), hk in zip(data, scored, heur):
                if LABELS[k] != r["label"]:
                    failures.append({"id": r["id"], "text": r["text"], "true": r["label"], "pred": LABELS[k],
                                     "score": round(s, 3), "heuristic": LABELS[hk], "language": r["language"],
                                     "style": r["style"], "ambiguous": r["ambiguous"]})
    results["perf"] = _perf([r["text"] for r in sets["probe"] + sets["test"]])
    results["real_data"] = {"status": "NOT_EVALUATED", "reason": "нет легально доступного корпуса реальных "
                            "обращений с метками; источники в research/round-12-results/R08/DATA_SOURCES.json"}
    sel = SELECTED.format(kind=model["kind"], kw="+keywords" if model["feature_params"].get("keyword_features") else "")
    results["headline"] = {
        "note": DEMO_NOTE, "test_look": TEST_LOOK, "model_version": model["version"],
        "test_macro_f1": {m: v["macro_f1"] for m, v in results["sets"]["test"]["methods"].items()},
        "test_ci_selected": results["sets"]["test"]["methods"][sel]["ci_macro_f1"],
        "probe_macro_f1": {m: v["macro_f1"] for m, v in results["sets"]["probe"]["methods"].items()},
        "probe_ci_selected": results["sets"]["probe"]["methods"][sel]["ci_macro_f1"],
        "test_delta_vs_heuristic": results["sets"]["test"]["paired_delta_selected_minus_heuristic"],
        "probe_delta_vs_heuristic": results["sets"]["probe"]["paired_delta_selected_minus_heuristic"],
        "real_data": "NOT_EVALUATED",
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "EVAL_REPORT.md").write_text(render_report(results, failures), encoding="utf-8")
    (out_dir / "metrics.json").write_text(json.dumps(results, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (out_dir / "probe_failures.json").write_text(json.dumps(failures, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return results


def _f(v):
    return "—" if v is None else f"{v:.3f}" if isinstance(v, float) else str(v)


def render_report(r: dict, failures: list) -> str:
    """Markdown-отчёт строится из тех же чисел, что metrics.json (без ручного переписывания)."""
    L = [f"# R08 — отчёт об оценке классификатора (генерируется `python -m ml.civic_classifier evaluate`)", "",
         f"**{r['note']}**", "", f"- Модель: `{r['model_version']}` ({r['model_kind']}"
         f"{' + признаки словаря' if r['keyword_features'] else ''}); порог из validation: {r['threshold_from_validation']}",
         f"- Корпус: `{r['corpus_sha256'][:16]}…`; альтернатива для сравнения: `{r['alt_model']}`",
         f"- Порядок экспериментов: {r['test_look']}",
         "- Реальные обращения: **NOT_EVALUATED** — " + r["real_data"]["reason"], ""]
    names = {"test": "Test — невиданные шаблоны синтетического корпуса",
             "probe": "Пробный набор — 112 сообщений, написанных агентом вне генератора (перенос стиля)",
             "val_reference_only": "Validation — справочно (на нём выбраны метод и порог, не независимая оценка)"}
    for key, title in names.items():
        e = r["sets"][key]
        L += [f"## {title} (n={e['n']})", "", "| Метод | Accuracy | Macro-F1 | 95% ДИ macro-F1 |", "|---|---|---|---|"]
        for m, v in e["methods"].items():
            ci = v["ci_macro_f1"]
            L.append(f"| {m} | {_f(v['accuracy'])} | {_f(v['macro_f1'])} | {_f(ci['low'])}–{_f(ci['high'])} "
                     f"({ci.get('unit', 'items')}) |")
        d = e["paired_delta_selected_minus_heuristic"]
        L += ["", f"Парный бутстрэп Δmacro-F1 (выбранная − эвристика): {d['delta']:+.3f} "
                  f"[{d['low']:+.3f}; {d['high']:+.3f}], доля ресэмплов с Δ>0: {d['share_boot_delta_gt_0']}.", ""]
        sel = next(iter(e["methods"].values()))
        L += ["| Класс | Precision | Recall | F1 | Support |", "|---|---|---|---|---|"]
        for lab, v in sel["per_class"].items():
            L.append(f"| {lab} | {_f(v['precision'])} | {_f(v['recall'])} | {_f(v['f1'])} | {v['support']} |")
        cm = sel["confusion"]
        L += ["", "Матрица ошибок выбранной модели (строки — истина, столбцы — прогноз):", "",
              "| истина \\ прогноз | " + " | ".join(cm["labels"]) + " |", "|---" * (len(cm["labels"]) + 1) + "|"]
        for lab, row in zip(cm["labels"], cm["rows_true_cols_pred"]):
            L.append(f"| {lab} | " + " | ".join(str(x) for x in row) + " |")
        L += ["", "Срезы (выбранная модель / эвристика):", ""]
        for sname, sl in e["slices_selected"].items():
            heur = e["slices_heuristic"].get(sname, {})
            parts = []
            for k, v in sl.items():
                h = heur.get(k)
                parts.append(f"{k}: n={v['n']}, F1 {_f(v['macro_f1'])}" + (f" / {_f(h['macro_f1'])}" if h else ""))
            L.append(f"- **{sname}** — " + "; ".join(parts))
        th = e["threshold_effect"]
        L += ["", f"- Калибровка (ECE max-score): {_f(e['calibration_ece_selected'])} — score не является вероятностью.",
              f"- Порог {th['threshold']} (если бы ему доверяли): авто-доля {_f(th['auto_share'])}, точность авто "
              f"{_f(th['precision_auto'])}. В runtime для синтетической модели needs_review=True всегда.",
              f"- Близость к train (Jaccard 3-грамм): среднее {e['near_duplicates']['max_train_jaccard_mean']}, "
              f"доля ≥0.6: {e['near_duplicates']['share_ge_0.6']}.", ""]
    p = r["perf"]
    L += ["## Время и память", "",
          f"Файл модели {p['model_file_bytes']} байт; загрузка {p['load_seconds']} с; пик выделений Python "
          f"{p['peak_python_alloc_mb']} МБ; classify в среднем {p['classify_ms_mean']} мс, p95 {p['classify_ms_p95']} мс "
          f"(n={p['n']}). {p['note']}.", "",
          f"## Ошибки на пробном наборе ({len(failures)})", "", "| id | текст | истина | прогноз | score | эвристика | стиль |",
          "|---|---|---|---|---|---|---|"]
    for f in failures:
        L.append(f"| {f['id']} | {f['text']} | {f['true']} | {f['pred']} | {f['score']} | {f['heuristic']} | {f['style']} |")
    return "\n".join(L) + "\n"
