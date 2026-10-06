"""Feature extraction. The feature policy is a plain dict stored inside the model
artifact so that training and inference cannot silently diverge."""

from collections import Counter

from .textnorm import kk_fold, normalize, words

DEFAULT_POLICY = {
    "char_ngram_min": 2,
    "char_ngram_max": 4,
    "word_unigrams": True,
    "word_bigrams": False,
    "kk_fold": False,
    "max_chars": 2000,
}


def _char_ngrams(text, nmin, nmax, prefix, out):
    for w in words(text):
        padded = f" {w} "
        L = len(padded)
        for n in range(nmin, nmax + 1):
            if L < n:
                break
            for i in range(L - n + 1):
                out[prefix + padded[i:i + n]] += 1


def extract(text, policy):
    """Return a Counter of string features for a raw text."""
    t = normalize(text)[: policy["max_chars"]]
    feats = Counter()
    _char_ngrams(t, policy["char_ngram_min"], policy["char_ngram_max"], "c:", feats)
    ws = words(t)
    if policy.get("word_unigrams"):
        for w in ws:
            feats["w:" + w] += 1
    if policy.get("word_bigrams"):
        for a, b in zip(ws, ws[1:]):
            feats["b:" + a + "_" + b] += 1
    if policy.get("kk_fold"):
        folded = kk_fold(t)
        if folded != t:
            extra = Counter()
            _char_ngrams(folded, policy["char_ngram_min"], policy["char_ngram_max"], "c:", extra)
            for w in words(folded):
                extra["w:" + w] += 1
            # add only features that differ from the unfolded ones
            for k, v in extra.items():
                if k not in feats:
                    feats[k] += v
    return feats
