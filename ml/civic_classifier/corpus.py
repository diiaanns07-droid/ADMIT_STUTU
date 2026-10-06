"""Corpus pipeline: generate synthetic records, validate schema, clean, deduplicate,
cluster near-duplicates, split by group, verify that no identical or near-identical
message crosses split boundaries.

No oversampling is performed anywhere. If a future step adds oversampling, it must
run AFTER ``verify_no_leakage`` and only inside the train split.
"""

import hashlib
import json
import os
import random
import re
from collections import Counter, defaultdict

from .labels import LABELS
from .textnorm import normalize

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
SPLITS = ("train", "validation", "test")
RECORD_LANGS = ("ru", "kk", "mixed")
SOURCES = ("synthetic_template", "synthetic_handwritten", "real_permitted")
NEAR_DUP_JACCARD = 0.8
SHINGLE = 5
MAX_TEXT = 2000


class SchemaError(ValueError):
    pass


class LeakageError(AssertionError):
    pass


# ---------------------------------------------------------------- schema
REQUIRED = {"id": str, "text": str, "language": str, "label": str, "group": str,
            "source": str, "evidence_type": str, "annotation": str}


def validate_record(r):
    if not isinstance(r, dict):
        raise SchemaError("record must be an object")
    for k, t in REQUIRED.items():
        if not isinstance(r.get(k), t):
            raise SchemaError(f"{r.get('id', '?')}: field {k} missing or not {t.__name__}")
    if r["label"] not in LABELS:
        raise SchemaError(f"{r['id']}: unknown label {r['label']!r}")
    if r["language"] not in RECORD_LANGS:
        raise SchemaError(f"{r['id']}: unknown language {r['language']!r}")
    if r["source"] not in SOURCES:
        raise SchemaError(f"{r['id']}: unknown source {r['source']!r}")
    if r["source"].startswith("synthetic") and r["evidence_type"] != "synthetic":
        raise SchemaError(f"{r['id']}: synthetic source must have evidence_type=synthetic")
    if not (1 <= len(r["text"].strip()) <= MAX_TEXT):
        raise SchemaError(f"{r['id']}: text empty or longer than {MAX_TEXT}")
    return r


def read_jsonl(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(validate_record(json.loads(line)))
            except json.JSONDecodeError as e:
                raise SchemaError(f"{path}:{n}: invalid JSON: {e}") from None
    return out


def write_jsonl(path, records):
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")


def records_hash(records):
    h = hashlib.sha256()
    for r in sorted(records, key=lambda r: r["id"]):
        h.update(json.dumps(r, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


# ---------------------------------------------------------------- generation
_ALT_RE = re.compile(r"\(([^()]*\|[^()]*)\)")
_SLOT_RE = re.compile(r"\{(\w+)\}")


def _expand(text, slots, rng):
    text = _SLOT_RE.sub(lambda m: rng.choice(slots[m.group(1)]), text)
    text = _ALT_RE.sub(lambda m: rng.choice(m.group(1).split("|")), text)
    return re.sub(r"\s+", " ", text).strip()


def generate_from_templates(templates_doc, per_template=30, seed=20261006):
    rng = random.Random(seed)
    out = []
    for t in templates_doc["templates"]:
        slots = templates_doc["slots"][t["language"]]
        seen = set()
        attempts = 0
        while len(seen) < per_template and attempts < per_template * 20:
            attempts += 1
            s = _expand(t["text"], slots, rng)
            if s in seen:
                continue
            seen.add(s)
            out.append({
                "id": f"{t['id']}-{len(seen):03d}",
                "text": s,
                "language": t["language"],
                "label": t["label"],
                "group": t["id"],
                "template_id": t["id"],
                "tags": [],
                "ambiguous": False,
                "source": "synthetic_template",
                "evidence_type": "synthetic",
                "annotation": "label_inherited_from_template_by_author",
            })
    return out


# ---------------------------------------------------------------- cleaning
def clean(records):
    """Exact dedup on normalised text. Returns (kept, report)."""
    seen = {}
    kept, dropped = [], []
    for r in sorted(records, key=lambda r: r["id"]):
        key = normalize(r["text"])
        if key in seen:
            dropped.append({"id": r["id"], "duplicate_of": seen[key]})
            continue
        seen[key] = r["id"]
        kept.append(r)
    return kept, {"exact_duplicates_dropped": dropped}


def _shingles(text):
    t = normalize(text)
    if len(t) <= SHINGLE:
        return {t}
    return {t[i:i + SHINGLE] for i in range(len(t) - SHINGLE + 1)}


def near_duplicate_pairs(recs_a, recs_b=None, threshold=NEAR_DUP_JACCARD):
    """Pairs (id_a, id_b, jaccard) with Jaccard >= threshold on char 5-gram shingles.

    If recs_b is None, pairs within recs_a. Uses an inverted index to avoid the
    full quadratic comparison.
    """
    same = recs_b is None
    recs_b = recs_a if same else recs_b
    sh_b = [(_shingles(r["text"]), r["id"]) for r in recs_b]
    index = defaultdict(list)
    for j, (s, _) in enumerate(sh_b):
        for g in s:
            index[g].append(j)
    pairs = []
    for i, ra in enumerate(recs_a):
        sa = _shingles(ra["text"])
        cand = Counter()
        for g in sa:
            for j in index.get(g, ()):
                cand[j] += 1
        for j, inter in cand.items():
            if same and j <= i:
                continue
            sb, idb = sh_b[j]
            union = len(sa) + len(sb) - inter
            jac = inter / union if union else 1.0
            if jac >= threshold:
                pairs.append((ra["id"], idb, round(jac, 4)))
    return pairs


# ---------------------------------------------------------------- split
def _find(parent, x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def make_splits(records, seed=20261006):
    """Group-aware split.

    * template groups: per (label, language) the templates are shuffled with
      *seed*; 1 template -> test, 1 -> validation, the rest -> train.
    * handwritten records never go to train; stratified by label alternately to
      validation / test.
    * near-duplicate clusters are merged across groups BEFORE assignment
      finalisation; a cluster touching an evaluation-only record follows it.
    """
    rng = random.Random(seed)
    group_split = {}
    by_lang_label = defaultdict(set)
    hw_by_label = defaultdict(list)
    for r in records:
        if r["source"] == "synthetic_template":
            by_lang_label[(r["language"], r["label"])].add(r["group"])
        else:
            hw_by_label[r["label"]].append(r["group"])
    for key in sorted(by_lang_label):
        groups = sorted(by_lang_label[key])
        rng.shuffle(groups)
        for i, g in enumerate(groups):
            group_split[g] = "test" if i == 0 else ("validation" if i == 1 else "train")
    for lab in sorted(hw_by_label):
        groups = sorted(set(hw_by_label[lab]))
        rng.shuffle(groups)
        for i, g in enumerate(groups):
            group_split[g] = "validation" if i % 2 == 0 else "test"

    # near-duplicate clusters over groups
    groups_all = sorted({r["group"] for r in records})
    parent = {g: g for g in groups_all}
    id2group = {r["id"]: r["group"] for r in records}
    pairs = near_duplicate_pairs(records)
    for a, b, _ in pairs:
        ga, gb = _find(parent, id2group[a]), _find(parent, id2group[b])
        if ga != gb:
            parent[max(ga, gb)] = min(ga, gb)
    clusters = defaultdict(list)
    for g in groups_all:
        clusters[_find(parent, g)].append(g)
    eval_only = {r["group"] for r in records if r["source"] != "synthetic_template"}
    merged = []
    for root, members in clusters.items():
        if len(members) == 1:
            continue
        hw = sorted(m for m in members if m in eval_only)
        target = group_split[hw[0]] if hw else group_split[min(members)]
        for m in members:
            if group_split[m] != target:
                merged.append({"group": m, "from": group_split[m], "to": target,
                               "cluster_root": root})
                group_split[m] = target
    out = {s: [] for s in SPLITS}
    for r in records:
        out[group_split[r["group"]]].append(r)
    report = {"cross_group_near_dup_pairs": len([1 for a, b, _ in pairs
                                                 if id2group[a] != id2group[b]]),
              "groups_moved_by_cluster_merge": merged}
    return out, report


def verify_no_leakage(splits, threshold=NEAR_DUP_JACCARD):
    """Raise LeakageError if identical/near-identical texts or shared groups cross splits."""
    problems = []
    seen_norm = {}
    seen_group = {}
    for s in SPLITS:
        for r in splits.get(s, []):
            k = normalize(r["text"])
            if k in seen_norm and seen_norm[k][0] != s:
                problems.append(("exact", seen_norm[k][1], r["id"]))
            seen_norm.setdefault(k, (s, r["id"]))
            g = r["group"]
            if g in seen_group and seen_group[g] != s:
                problems.append(("group", g, r["id"]))
            seen_group.setdefault(g, s)
    names = [s for s in SPLITS if splits.get(s)]
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            for ia, ib, jac in near_duplicate_pairs(splits[a], splits[b], threshold):
                problems.append(("near", ia, ib, jac))
    if problems:
        raise LeakageError(f"{len(problems)} leakage problem(s), first: {problems[:5]}")
    return True


def summarize(records):
    return {
        "n": len(records),
        "by_label": dict(sorted(Counter(r["label"] for r in records).items())),
        "by_language": dict(sorted(Counter(r["language"] for r in records).items())),
        "by_source": dict(sorted(Counter(r["source"] for r in records).items())),
        "groups": len({r["group"] for r in records}),
        "sha256": records_hash(records),
    }


def load_splits(split_dir):
    """Load the three split files and verify them against split_manifest.json."""
    man_path = os.path.join(split_dir, "split_manifest.json")
    try:
        with open(man_path, encoding="utf-8") as f:
            man = json.load(f)
    except (OSError, ValueError) as e:
        raise SchemaError(f"split manifest unreadable: {e}") from None
    if not isinstance(man, dict) or not isinstance(man.get("splits"), dict):
        raise SchemaError("split manifest: 'splits' object missing")
    out = {}
    for s in SPLITS:
        info = man["splits"].get(s)
        if not isinstance(info, dict) or "file" not in info or "sha256" not in info:
            raise SchemaError(f"split manifest: entry for {s} invalid")
        fname = info["file"]
        if os.path.basename(fname) != fname:
            raise SchemaError("split manifest: file must be a plain name")
        recs = read_jsonl(os.path.join(split_dir, fname))
        if records_hash(recs) != info["sha256"]:
            raise SchemaError(f"split {s}: sha256 mismatch with manifest")
        out[s] = recs
    verify_no_leakage(out)
    return out, man
