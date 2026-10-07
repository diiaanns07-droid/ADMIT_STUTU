"""Аудит воспроизводимости и утечек закреплённого синтетического корпуса (R08, раунд 13).

    python -m ml.civic_classifier audit [--out DIR]

1. Воспроизведение: корпус и split пересобираются во временную папку, модели переобучаются;
   sha256 сравниваются с закреплёнными файлами (без сети, без «скачать latest»).
2. Утечки между train / val / test:
   - точные дубликаты после нормализации;
   - близкие перефразы: max Jaccard символьных 3-грамм к train;
   - «семейства» (label, family): один тип проблемы в разных шаблонах — парафразы и переводы
     RU/KK/смешанный — в разных splits (split по шаблону этого не запрещает);
   - круговая лексика: доля сообщений, содержащих основу словаря эвристики своей метки
     (словарь и шаблоны написаны одним автором; это даёт эвристике встроенное преимущество);
   - история словаря: основы STEMS не менялись после первого коммита (проверка по git — в отчёте раунда 13).
Результат — факты о синтетическом наборе, а не о реальных обращениях.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

from ml.civic_classifier.corpus import CORPUS_PATH, SPLIT_PATH, T, _grams, build, load_corpus, max_similarity, sha256_file
from ml.civic_classifier.heuristic import STEMS, keyword_hits
from ml.civic_classifier.labels import LABELS
from ml.civic_classifier.model import DEFAULT_MODEL_PATH
from ml.civic_classifier.text import normalize

PROBE_PATH = CORPUS_PATH.parent / "probe_agent_v1.jsonl"


def family_key(row: dict) -> str:
    """Единица происхождения: метка + семейство шаблонов (парафразы и переводы одной проблемы)."""
    return f'{row["label"]}/{row["family"]}'


def reproduce(work: Path) -> dict:
    from ml.civic_classifier.train import train
    m = build(work)
    out = {
        "corpus_sha256_rebuilt": m["corpus_sha256"], "corpus_sha256_pinned": sha256_file(CORPUS_PATH),
        "split_sha256_rebuilt": sha256_file(work / SPLIT_PATH.name), "split_sha256_pinned": sha256_file(SPLIT_PATH),
    }
    s = train(model_path=work / "model.json.gz", report_path=work / "train_report.json")
    out.update({
        "model_file_sha256_rebuilt": hashlib.sha256((work / "model.json.gz").read_bytes()).hexdigest(),
        "model_file_sha256_pinned": hashlib.sha256(DEFAULT_MODEL_PATH.read_bytes()).hexdigest(),
        "alt_nb_file_equal": (work / "model_alt_nb.json.gz").read_bytes()
        == (DEFAULT_MODEL_PATH.parent / "model_alt_nb.json.gz").read_bytes(),
        "model_version": s["version"], "selection": s["selection"]["chosen"],
    })
    out["identical"] = (out["corpus_sha256_rebuilt"] == out["corpus_sha256_pinned"]
                        and out["split_sha256_rebuilt"] == out["split_sha256_pinned"]
                        and out["model_file_sha256_rebuilt"] == out["model_file_sha256_pinned"]
                        and out["alt_nb_file_equal"])
    return out


def leakage(rows: list[dict]) -> dict:
    by_split = defaultdict(list)
    for r in rows:
        by_split[r["split"]].append(r)
    norm = defaultdict(set)
    for r in rows:
        norm[normalize(r["text"])].add(r["split"])
    fam_splits, fam_langs = defaultdict(set), defaultdict(lambda: defaultdict(set))
    for r in rows:
        fam_splits[family_key(r)].add(r["split"])
        fam_langs[family_key(r)][r["split"]].add(r["language"])
    train_g = [_grams(r["text"]) for r in by_split["train"]]
    out = {"rows": dict(Counter(r["split"] for r in rows)),
           "exact_duplicates_across_splits": sum(1 for v in norm.values() if len(v - {"excluded_near_dup"}) > 1),
           "templates": len(T), "families": len(fam_splits),
           "families_in_more_than_one_split": sum(1 for v in fam_splits.values() if len(v - {"excluded_near_dup"}) > 1),
           "per_split": {}}
    for s in ("val", "test"):
        rs = by_split[s]
        sims = max_similarity([_grams(r["text"]) for r in rs], train_g)
        fam_in_train = [r for r in rs if "train" in fam_splits[family_key(r)]]
        cross_lang = [r for r in rs if any(lang != r["language"] for lang in fam_langs[family_key(r)]["train"])]
        out["per_split"][s] = {
            "rows": len(rs),
            "max_train_jaccard_ge_0_6": sum(1 for x in sims if x >= 0.6),
            "max_train_jaccard_mean": round(sum(sims) / len(sims), 3) if sims else None,
            "rows_whose_family_is_in_train": len(fam_in_train),
            "rows_with_same_family_train_rows_in_another_language": len(cross_lang),
            "families": len({family_key(r) for r in rs}),
        }
    return out


def lexical_circularity(rows: list[dict], probe: list[dict]) -> dict:
    def stats(rs):
        gold = sum(1 for r in rs if keyword_hits(r["text"])[r["label"]] > 0)
        anyh = sum(1 for r in rs if any(keyword_hits(r["text"]).values()))
        multi = sum(1 for r in rs if sum(1 for v in keyword_hits(r["text"]).values() if v) >= 2)
        return {"rows": len(rs), "share_with_gold_label_stem": round(gold / len(rs), 3),
                "share_with_any_stem": round(anyh / len(rs), 3),
                "share_with_stems_of_2plus_labels": round(multi / len(rs), 3)}
    out = {s: stats([r for r in rows if r["split"] == s]) for s in ("train", "val", "test")}
    out["probe_agent_v1"] = stats(probe)
    out["stems_per_label"] = {k: len(v) for k, v in STEMS.items()}
    out["note"] = ("Основы словаря и шаблоны корпуса написаны одним агентом. Высокая доля сообщений с основой "
                   "своей метки означает, что синтетика благоприятствует эвристике; на реальных текстах это не так.")
    return out


def audit() -> dict:
    rows, manifest = load_corpus()
    probe = [json.loads(line) for line in PROBE_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
    with tempfile.TemporaryDirectory() as tmp:
        repro = reproduce(Path(tmp))
    pg = max_similarity([_grams(r["text"]) for r in probe], [_grams(r["text"]) for r in rows])
    return {
        "schema": "civic-r08-audit-v1",
        "corpus_sha256": manifest["corpus_sha256"], "split_sha256": sha256_file(SPLIT_PATH),
        "probe_sha256": sha256_file(PROBE_PATH),
        "reproduction": repro,
        "leakage": leakage(rows),
        "probe_vs_corpus": {"rows": len(probe), "max_jaccard_ge_0_6": sum(1 for x in pg if x >= 0.6),
                            "max_jaccard_max": round(max(pg), 3),
                            "status": "exploratory: written by the same agent; errors listed in round-12 FAILURES.md"},
        "lexical_circularity": lexical_circularity(rows, probe),
        "labels": list(LABELS),
    }
