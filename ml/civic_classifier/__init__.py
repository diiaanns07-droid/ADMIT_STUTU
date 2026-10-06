"""Civic message topic classifier (round 11, role R08).

Public API (civic-v1, CONTRACT.txt section 6):
    from ml.civic_classifier import classify, LABELS
    classify("Яма на дороге", "ru") -> dict (see classify.py docstring)

Importing this package does not load the model; the artifact is loaded lazily on
the first classify() call and failures yield status="model_unavailable".
"""

from .classify import SCHEMA_VERSION, classify, model_info, reset_cache
from .labels import LABELS

__all__ = ["classify", "model_info", "reset_cache", "LABELS", "SCHEMA_VERSION"]
