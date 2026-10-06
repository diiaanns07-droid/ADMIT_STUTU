"""Pure-Python linear text classifiers (no numpy/sklearn, no pickle).

* MultinomialNB  - baseline. Additive smoothing, features from features.extract.
* SoftmaxLinear  - candidate. Multinomial logistic regression trained with
  seeded SGD + L2 on L2-normalised tf features.

Both expose ``decision(feats) -> {label: raw_score}`` and are serialised to plain
dicts of numbers (JSON). Raw scores are NOT probabilities; see classify.py for
the documented, uncalibrated "score".
"""

import math
import random
from collections import Counter, defaultdict


class MultinomialNB:
    kind = "multinomial_nb"

    def __init__(self, labels, alpha=0.5, min_df=2):
        self.labels = list(labels)
        self.alpha = alpha
        self.min_df = min_df
        self.log_prior = {}
        self.log_lik = {}      # feature -> [per label]
        self.log_unseen = []   # per label, for features seen in vocab but 0 count
        self.vocab_size = 0

    def fit(self, feats_list, y):
        df = Counter()
        for f in feats_list:
            df.update(f.keys())
        vocab = {k for k, c in df.items() if c >= self.min_df}
        self.vocab_size = len(vocab)
        n = len(y)
        counts = {lab: Counter() for lab in self.labels}
        cls_n = Counter(y)
        for f, lab in zip(feats_list, y):
            c = counts[lab]
            for k, v in f.items():
                if k in vocab:
                    c[k] += v
        V = len(vocab)
        totals = {lab: sum(counts[lab].values()) for lab in self.labels}
        self.log_prior = {
            lab: math.log((cls_n[lab] + 1) / (n + len(self.labels))) for lab in self.labels
        }
        denom = {lab: totals[lab] + self.alpha * V for lab in self.labels}
        self.log_lik = {}
        for k in sorted(vocab):
            self.log_lik[k] = [
                round(math.log((counts[lab][k] + self.alpha) / denom[lab]), 6)
                for lab in self.labels
            ]
        return self

    def decision(self, feats):
        s = [self.log_prior[lab] for lab in self.labels]
        used = 0
        for k, v in feats.items():
            row = self.log_lik.get(k)
            if row is None:
                continue
            used += v
            for i, w in enumerate(row):
                s[i] += v * w
        return dict(zip(self.labels, s)), used

    def to_dict(self):
        return {"kind": self.kind, "labels": self.labels, "alpha": self.alpha,
                "min_df": self.min_df, "log_prior": self.log_prior,
                "log_lik": self.log_lik, "vocab_size": self.vocab_size}

    @classmethod
    def from_dict(cls, d):
        m = cls(d["labels"], d["alpha"], d["min_df"])
        m.log_prior = d["log_prior"]
        m.log_lik = d["log_lik"]
        m.vocab_size = d["vocab_size"]
        return m


def _l2(feats):
    norm = math.sqrt(sum(v * v for v in feats.values())) or 1.0
    return {k: v / norm for k, v in feats.items()}


class SoftmaxLinear:
    kind = "softmax_linear"

    def __init__(self, labels, epochs=12, lr=0.5, l2=1e-4, min_df=2, seed=13):
        self.labels = list(labels)
        self.epochs = epochs
        self.lr = lr
        self.l2 = l2
        self.min_df = min_df
        self.seed = seed
        self.weights = {}   # feature -> [per label]
        self.bias = [0.0] * len(self.labels)
        self.vocab_size = 0

    def _scores(self, x):
        s = list(self.bias)
        for k, v in x.items():
            row = self.weights.get(k)
            if row is None:
                continue
            for i, w in enumerate(row):
                s[i] += v * w
        return s

    def fit(self, feats_list, y):
        df = Counter()
        for f in feats_list:
            df.update(f.keys())
        vocab = {k for k, c in df.items() if c >= self.min_df}
        self.vocab_size = len(vocab)
        X = [_l2({k: v for k, v in f.items() if k in vocab}) for f in feats_list]
        idx = {lab: i for i, lab in enumerate(self.labels)}
        Y = [idx[lab] for lab in y]
        K = len(self.labels)
        W = defaultdict(lambda: [0.0] * K)
        b = [0.0] * K
        rng = random.Random(self.seed)
        order = list(range(len(X)))
        step = 0
        for ep in range(self.epochs):
            rng.shuffle(order)
            for j in order:
                step += 1
                eta = self.lr / (1.0 + 0.01 * step / len(X))
                x = X[j]
                s = list(b)
                for k, v in x.items():
                    row = W[k]
                    for i in range(K):
                        s[i] += v * row[i]
                m = max(s)
                e = [math.exp(z - m) for z in s]
                Z = sum(e)
                p = [z / Z for z in e]
                p[Y[j]] -= 1.0  # gradient of CE wrt logits
                for i in range(K):
                    b[i] -= eta * p[i]
                decay = 1.0 - eta * self.l2
                for k, v in x.items():
                    row = W[k]
                    for i in range(K):
                        row[i] = row[i] * decay - eta * p[i] * v
        self.weights = {k: [round(w, 6) for w in W[k]] for k in sorted(W)
                        if any(abs(w) > 1e-6 for w in W[k])}
        self.bias = [round(v, 6) for v in b]
        return self

    def decision(self, feats):
        x = _l2(feats)
        used = sum(1 for k in feats if k in self.weights)
        return dict(zip(self.labels, self._scores(x))), used

    def to_dict(self):
        return {"kind": self.kind, "labels": self.labels, "epochs": self.epochs,
                "lr": self.lr, "l2": self.l2, "min_df": self.min_df, "seed": self.seed,
                "weights": self.weights, "bias": self.bias, "vocab_size": self.vocab_size}

    @classmethod
    def from_dict(cls, d):
        m = cls(d["labels"], d["epochs"], d["lr"], d["l2"], d["min_df"], d["seed"])
        m.weights = d["weights"]
        m.bias = d["bias"]
        m.vocab_size = d["vocab_size"]
        return m


class MajorityClass:
    """Sanity baseline only; never shipped."""
    kind = "majority"

    def __init__(self, labels):
        self.labels = list(labels)
        self.top = None

    def fit(self, feats_list, y):
        self.top = Counter(y).most_common(1)[0][0]
        return self

    def decision(self, feats):
        return {lab: (1.0 if lab == self.top else 0.0) for lab in self.labels}, 0


MODEL_KINDS = {MultinomialNB.kind: MultinomialNB, SoftmaxLinear.kind: SoftmaxLinear}


def softmax(scores):
    m = max(scores.values())
    e = {k: math.exp(v - m) for k, v in scores.items()}
    z = sum(e.values())
    return {k: v / z for k, v in e.items()}


def score_from_decision(kind, scores, used):
    """Return (ranked labels, uncalibrated margin score in [0,1], score_kind).

    margin = top1 - top2 of a softmax over raw decision values (for NB the raw
    values are divided by the number of matched feature occurrences first, so the
    margin does not grow just because a text is long). It is a ranking signal for
    needs_review, NOT a probability of correctness.
    """
    if kind == MultinomialNB.kind:
        scale = max(used, 1)
        scores = {k: v / scale for k, v in scores.items()}
        # temperature chosen once (not tuned on test) to keep margins spread out
        scores = {k: v * 4.0 for k, v in scores.items()}
        score_kind = "nb_length_normalized_softmax_margin_uncalibrated"
    else:
        score_kind = "linear_softmax_margin_uncalibrated"
    p = softmax(scores)
    ranked = sorted(p, key=lambda k: (-p[k], k))
    margin = p[ranked[0]] - p[ranked[1]]
    return ranked, round(margin, 6), score_kind
