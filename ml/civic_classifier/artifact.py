"""Model artifact I/O. JSON only - never pickle.

Loading rules (defence against arbitrary files from a request or a repository):
* the artifact must live inside this package's ``model/`` directory (or a
  directory explicitly passed by trusted server code, never by a request);
* its sha256 must equal the value recorded in ``model/MODEL_REGISTRY.json``;
* size limit, strict JSON (no NaN/Infinity), schema and label-set checks.
Any violation raises ArtifactError; classify.py converts that into a safe
``model_unavailable`` response.
"""

import hashlib
import json
import math
import os

from .labels import LABELS
from .models import MODEL_KINDS

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(PKG_DIR, "model")
REGISTRY_NAME = "MODEL_REGISTRY.json"
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
ARTIFACT_FORMAT = "civic-classifier-artifact-v1"


class ArtifactError(Exception):
    pass


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _reject_constant(name):
    raise ArtifactError(f"non-finite constant {name} in artifact")


def dump_artifact(model, policy, meta, path):
    payload = {
        "format": ARTIFACT_FORMAT,
        "model_version": meta["model_version"],
        "training_data_status": meta["training_data_status"],
        "feature_policy": policy,
        "review_threshold": meta["review_threshold"],
        "meta": meta,
        "model": model.to_dict(),
    }
    data = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")
    with open(path, "wb") as f:
        f.write(data)
    return sha256_bytes(data)


def _check_finite_rows(rows, width, what):
    for k, row in rows.items():
        if not isinstance(row, list) or len(row) != width:
            raise ArtifactError(f"{what}: bad row for {k!r}")
        for v in row:
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                raise ArtifactError(f"{what}: non-numeric value for {k!r}")


def validate_payload(p):
    if not isinstance(p, dict) or p.get("format") != ARTIFACT_FORMAT:
        raise ArtifactError("unknown artifact format")
    for key in ("model_version", "training_data_status", "feature_policy",
                "review_threshold", "model"):
        if key not in p:
            raise ArtifactError(f"missing key {key}")
    m = p["model"]
    if m.get("kind") not in MODEL_KINDS:
        raise ArtifactError("unknown model kind")
    if tuple(m.get("labels", ())) != LABELS:
        raise ArtifactError("label set differs from civic-v1 LABELS")
    thr = p["review_threshold"]
    if not isinstance(thr, (int, float)) or not (0.0 <= thr <= 1.0):
        raise ArtifactError("review_threshold must be in [0,1]")
    K = len(LABELS)
    if m["kind"] == "multinomial_nb":
        _check_finite_rows(m["log_lik"], K, "log_lik")
    else:
        _check_finite_rows(m["weights"], K, "weights")
        _check_finite_rows({"bias": m["bias"]}, K, "bias")
    pol = p["feature_policy"]
    if not (1 <= pol.get("char_ngram_min", 0) <= pol.get("char_ngram_max", 0) <= 6):
        raise ArtifactError("bad feature policy")
    return p


def read_registry(model_dir=MODEL_DIR):
    path = os.path.join(model_dir, REGISTRY_NAME)
    try:
        with open(path, "r", encoding="utf-8") as f:
            reg = json.load(f, parse_constant=_reject_constant)
    except (OSError, ValueError) as e:
        raise ArtifactError(f"registry unreadable: {e}") from None
    if not isinstance(reg, dict) or "default" not in reg or "artifacts" not in reg:
        raise ArtifactError("registry schema invalid")
    return reg


def load_artifact(name=None, model_dir=MODEL_DIR):
    """Load a registered artifact by *name* (registry key), verifying sha256."""
    reg = read_registry(model_dir)
    name = name or reg["default"]
    entry = reg["artifacts"].get(name)
    if not isinstance(entry, dict):
        raise ArtifactError(f"artifact {name!r} not registered")
    fname = entry.get("file", "")
    if os.path.basename(fname) != fname or not fname.endswith(".json"):
        raise ArtifactError("artifact file name must be a plain .json name")
    path = os.path.join(model_dir, fname)
    real_dir = os.path.realpath(model_dir)
    if os.path.commonpath([os.path.realpath(path), real_dir]) != real_dir:
        raise ArtifactError("artifact outside model directory")
    try:
        size = os.path.getsize(path)
    except OSError:
        raise ArtifactError("artifact file missing") from None
    if size > MAX_ARTIFACT_BYTES:
        raise ArtifactError("artifact too large")
    with open(path, "rb") as f:
        data = f.read()
    if sha256_bytes(data) != entry.get("sha256"):
        raise ArtifactError("sha256 mismatch: artifact differs from registry")
    try:
        payload = json.loads(data.decode("utf-8"), parse_constant=_reject_constant)
    except ValueError as e:
        raise ArtifactError(f"artifact JSON invalid: {e}") from None
    validate_payload(payload)
    model = MODEL_KINDS[payload["model"]["kind"]].from_dict(payload["model"])
    return payload, model
