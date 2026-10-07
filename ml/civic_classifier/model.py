"""Артефакт модели: JSON (gzip), без pickle/joblib, с проверкой sha256 содержимого.

Формат civic-clf-model-v1:
  kind: "logreg" (мультиклассовая логистическая регрессия) | "nb" (мультиномиальный Naive Bayes)
  labels, feature_params, features (список признаков), params (по меткам), threshold, метаданные,
  payload_sha256 — sha256 канонического JSON всех остальных полей.
Загрузка проверяет формат, метки и хэш; при любой ошибке модель не используется.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
from pathlib import Path

from ml.civic_classifier.labels import LABELS
from ml.civic_classifier.text import features

MODEL_FORMAT = "civic-clf-model-v1"
DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / "data" / "model.json.gz"
MAX_MODEL_BYTES = 32 * 1024 * 1024


class ModelError(ValueError):
    pass


def canonical(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def payload_hash(model: dict) -> str:
    return hashlib.sha256(canonical({k: v for k, v in model.items() if k != "payload_sha256"})).hexdigest()


def save_model(model: dict, path: Path) -> str:
    model = dict(model)
    model["payload_sha256"] = payload_hash(model)
    data = canonical(model)
    path.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0: одинаковая модель -> одинаковые байты файла.
    with open(path, "wb") as fh, gzip.GzipFile(fileobj=fh, mode="wb", mtime=0, compresslevel=9) as gz:
        gz.write(data)
    return model["payload_sha256"]


def load_model(path: Path | None = None) -> dict:
    path = DEFAULT_MODEL_PATH if path is None else path  # читаем модульный атрибут в момент вызова
    try:
        chunks, size = [], 0
        with gzip.open(path, "rb") as gz:
            # Читаем частями с лимитом: защита от gzip-бомбы без предварительного буфера на весь лимит.
            while chunk := gz.read(1 << 20):
                size += len(chunk)
                if size > MAX_MODEL_BYTES:
                    raise ModelError("model too large")
                chunks.append(chunk)
        model = json.loads(b"".join(chunks).decode("utf-8"))
    except (OSError, ValueError, EOFError) as exc:
        raise ModelError(f"model unreadable: {type(exc).__name__}") from exc
    if not isinstance(model, dict) or model.get("format") != MODEL_FORMAT:
        raise ModelError("model format")
    if tuple(model.get("labels") or ()) != LABELS:
        raise ModelError("model labels differ from CATEGORIES")
    if model.get("kind") not in ("logreg", "nb"):
        raise ModelError("model kind")
    if model.get("payload_sha256") != payload_hash(model):
        raise ModelError("model payload hash mismatch")
    feats = model.get("features")
    params = model.get("params")
    if not isinstance(feats, list) or not isinstance(params, dict):
        raise ModelError("model body")
    model["_index"] = {f: i for i, f in enumerate(feats)}
    return model


def vectorize(text: str, model: dict) -> dict[int, float]:
    """Счётчики известных признаков. Для logreg — log1p + L2-нормировка (как при обучении)."""
    fp = model["feature_params"]
    raw = features(text, char_ngrams=tuple(fp["char_ngrams"]), word_prefix=fp["word_prefix"])
    index = model["_index"] if "_index" in model else {f: i for i, f in enumerate(model["features"])}
    vec = {index[f]: v for f, v in raw.items() if f in index}
    if model["kind"] == "logreg":
        vec = {i: math.log1p(v) for i, v in vec.items()}
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        vec = {i: v / norm for i, v in vec.items()}
    if fp.get("keyword_features"):
        vec.update(keyword_vector(text, index, fp["keyword_scale"]))
    return vec


def keyword_vector(text: str, index: dict, scale: float) -> dict[int, float]:
    """Гибрид: совпадения словаря эвристики как отдельные признаки (вне L2-нормировки n-грамм)."""
    from ml.civic_classifier.heuristic import keyword_hits
    hits = keyword_hits(text)
    out = {index["k:" + lab]: min(h, 3) * scale for lab, h in hits.items() if h and "k:" + lab in index}
    if not out and "k:none" in index:
        out[index["k:none"]] = scale
    return out


def softmax(scores: list[float]) -> list[float]:
    m = max(scores)
    exps = [math.exp(s - m) for s in scores]
    total = sum(exps)
    return [e / total for e in exps]


def predict_scores(text: str, model: dict) -> list[float]:
    """Нормированные по softmax оценки по меткам (НЕ калиброванная вероятность)."""
    vec = vectorize(text, model)
    p = model["params"]
    if model["kind"] == "logreg":
        scores = list(p["bias"])
        for i, v in vec.items():
            row = p["weights"][i]
            for k in range(len(scores)):
                scores[k] += row[k] * v
    else:
        scores = list(p["log_prior"])
        for i, v in vec.items():
            row = p["log_prob"][i]
            for k in range(len(scores)):
                scores[k] += row[k] * v
        # Признаки вне словаря не учитываются: словарь фиксирован при обучении.
    return softmax(scores)
