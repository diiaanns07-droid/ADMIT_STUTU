import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

RESPONSE_KEYS = {
    "schema_version", "status", "label", "score", "score_kind", "needs_review",
    "review_reasons", "alternatives", "language", "language_source", "model_version",
    "training_data_status", "advisory",
}


def rec(i, text, label="roads", group=None, language="ru", source="synthetic_template"):
    return {"id": f"t-{i}", "text": text, "language": language, "label": label,
            "group": group or f"g-{i}", "source": source, "evidence_type": "synthetic",
            "annotation": "test", "tags": []}
