"""Text normalisation and a transparent heuristic language detector.

Policy (see MODEL_CARD.txt):
* Unicode NFC + casefold. Kazakh letters ә ғ қ ң ө ұ ү һ і are PRESERVED.
* Latin homoglyphs inside a Cyrillic-majority word are mapped to the Cyrillic
  letter they imitate (e.g. Latin "i" -> Kazakh "і", Latin "a" -> "а").
  Nothing is ever mapped from Cyrillic to Latin.
* ``kk_fold`` (optional, feature-level only) maps Kazakh-specific letters to the
  nearest *Cyrillic* letter (қ->к, ғ->г, ...) so that messages typed without a
  Kazakh keyboard share features with correctly spelled ones. The original
  letters are still used as features; folding only adds features.
"""

import re
import unicodedata

KK_SPECIFIC = set("әғқңөұүһі")

# Cyrillic-only folding for messages typed without Kazakh layout.
KK_FOLD = str.maketrans({
    "ә": "а", "ғ": "г", "қ": "к", "ң": "н", "ө": "о",
    "ұ": "у", "ү": "у", "һ": "х", "і": "и",
})

# Latin letters that look identical to Cyrillic ones. Applied only inside words
# that are already mostly Cyrillic.
# Case-aware: applied BEFORE casefold, because e.g. Latin "H" imitates Cyrillic
# "Н" while lowercase "h" imitates Kazakh "һ".
LATIN_TO_CYRILLIC_HOMOGLYPH = {
    "a": "а", "e": "е", "o": "о", "p": "р", "c": "с", "x": "х", "y": "у",
    "k": "к", "i": "і",
    "A": "А", "B": "В", "E": "Е", "K": "К", "M": "М", "H": "Н", "O": "О",
    "P": "Р", "C": "С", "T": "Т", "X": "Х", "Y": "У", "I": "І",
}

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
_SPACE_RE = re.compile(r"\s+")

KK_MARKERS = {
    "және", "жоқ", "бар", "үшін", "көше", "көшесінде", "жол", "жолда", "мен", "емес",
    "керек", "тұр", "қала", "бойынша", "өтінеміз", "сұраймыз", "жарық", "аялдама",
    "аялдамада", "шам", "шамдар", "ағаш", "ағаштар", "бұл", "біз", "біздің", "ауласында",
    "жанында", "қарсысында", "ауданында", "істемейді", "жанбайды", "сынған", "қашан",
    "тротуарда", "жоқ.", "де", "да", "ма", "ме", "ғой", "көп", "қиын", "болды", "жөндеу",
}
RU_MARKERS = {
    "и", "не", "на", "в", "что", "нет", "очень", "пожалуйста", "улица", "улице", "у",
    "дома", "уже", "просим", "прошу", "это", "как", "когда", "возле", "около", "по",
    "работает", "горит", "сломан", "сломана", "сломаны", "яма", "ямы", "тротуар",
    "остановке", "фонари", "деревья", "скамейки", "с", "до", "из", "мы", "вас",
    "почему", "есть", "нужно", "надо", "двор", "дворе",
}


def _is_cyr(ch):
    return "Ѐ" <= ch <= "ӿ"


def _is_lat(ch):
    return ("a" <= ch <= "z") or ("A" <= ch <= "Z")


def _fix_homoglyphs(word):
    cyr = sum(1 for ch in word if _is_cyr(ch))
    lat = sum(1 for ch in word if _is_lat(ch))
    if cyr == 0 or lat == 0 or cyr < lat:
        return word
    return "".join(LATIN_TO_CYRILLIC_HOMOGLYPH.get(ch, ch) for ch in word)


def normalize(text):
    """NFC, casefold, homoglyph repair, whitespace collapse. Keeps Kazakh letters."""
    if not isinstance(text, str):
        raise TypeError("text must be str")
    t = unicodedata.normalize("NFC", text)
    t = _WORD_RE.sub(lambda m: _fix_homoglyphs(m.group(0)), t)
    t = unicodedata.normalize("NFC", t.casefold())
    t = t.replace("ё", "е")
    t = _SPACE_RE.sub(" ", t).strip()
    return t


def kk_fold(normalized_text):
    return normalized_text.translate(KK_FOLD)


def words(normalized_text):
    return _WORD_RE.findall(normalized_text)


def detect_language(text):
    """Return (language, evidence) where language in ru|kk|mixed|und|unsupported_script.

    Heuristic, documented and testable; it is not a trained language-ID model.
    """
    t = normalize(text)
    letters = [ch for ch in t if ch.isalpha()]
    ev = {"letters": len(letters)}
    if len(letters) < 3:
        return "und", ev
    cyr = sum(1 for ch in letters if _is_cyr(ch))
    lat = sum(1 for ch in letters if _is_lat(ch))
    ev.update(cyrillic=cyr, latin=lat)
    if lat > cyr:
        return "unsupported_script", ev
    if cyr == 0:
        return "und", ev
    ws = words(t)
    kk_letters = sum(1 for ch in letters if ch in KK_SPECIFIC)
    kk_words = sum(1 for w in ws if w in KK_MARKERS or any(c in KK_SPECIFIC for c in w))
    ru_words = sum(1 for w in ws if w in RU_MARKERS)
    ev.update(kk_letters=kk_letters, kk_words=kk_words, ru_words=ru_words, words=len(ws))
    if kk_words == 0 and ru_words == 0:
        return "und", ev
    if kk_words and ru_words:
        share = kk_words / (kk_words + ru_words)
        if 0.3 <= share <= 0.7 and min(kk_words, ru_words) >= 2:
            return "mixed", ev
        return ("kk" if share > 0.5 else "ru"), ev
    return ("kk" if kk_words else "ru"), ev
