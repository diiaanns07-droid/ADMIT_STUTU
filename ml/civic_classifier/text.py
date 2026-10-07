"""Нормализация, обезличивание и признаки текста (только stdlib).

anonymize() заменяет телефоны, e-mail, ИИН/длинные номера и ссылки на маркеры до
любой обработки: модель не видит и не хранит персональные данные. Тот же код
применяется при сборке корпуса и при classify().
"""

from __future__ import annotations

import re
import unicodedata

_URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"(?:\+?[78][\s\-()]*)?(?:\d[\s\-()]*){10}(?!\d)")
_LONG_NUM = re.compile(r"\b\d{9,}\b")  # ИИН/БИН/номера договоров
_SPACE = re.compile(r"\s+")
_NON_WORD = re.compile(r"[^\w\s]", re.U)
_DIGITS = re.compile(r"\d+")
KAZAKH_LETTERS = set("әғқңөұүһіӘҒҚҢӨҰҮҺІ")


def anonymize(text: str) -> tuple[str, dict]:
    """Маркеры вместо персональных данных; возвращает текст и счётчики замен."""
    counts = {}

    def sub(rx, marker, value):
        new, n = rx.subn(marker, value)
        if n:
            key = marker.strip(" <>")
            counts[key] = counts.get(key, 0) + n
        return new

    text = sub(_URL, " <url> ", text)
    text = sub(_EMAIL, " <email> ", text)
    text = sub(_LONG_NUM, " <id> ", text)  # раньше телефона: 12 цифр ИИН подряд — не телефон
    text = sub(_PHONE, " <phone> ", text)
    return text, counts


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text, _ = anonymize(text)
    text = text.casefold().replace("ё", "е")
    text = _NON_WORD.sub(" ", text.replace("<", " ").replace(">", " "))
    text = _DIGITS.sub("0", text)
    return _SPACE.sub(" ", text).strip()


def detect_language(text: str) -> str:
    """Копия правила ui/civic_feedback/text.py: kk при казахских буквах, ru при кириллице."""
    if any(ch in KAZAKH_LETTERS for ch in text):
        return "kk"
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return "unknown"
    cyr = sum(1 for ch in letters if "Ѐ" <= ch <= "ӿ")
    return "ru" if cyr >= len(letters) / 2 else "unknown"


def features(text: str, *, char_ngrams=(2, 5), word_prefix=5) -> dict[str, float]:
    """Счётчики признаков: символьные n-граммы внутри слов (с границами) + префиксы слов.

    Префикс слова (первые 5 букв) — грубая замена стемминга для RU/KK морфологии.
    """
    norm = normalize(text)
    feats: dict[str, float] = {}
    lo, hi = char_ngrams
    for word in norm.split():
        padded = f" {word} "
        for n in range(lo, hi + 1):
            for i in range(len(padded) - n + 1):
                g = "c:" + padded[i:i + n]
                feats[g] = feats.get(g, 0.0) + 1.0
        if len(word) >= 3:
            w = "w:" + word[:word_prefix]
            feats[w] = feats.get(w, 0.0) + 1.0
    return feats
