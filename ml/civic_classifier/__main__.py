"""CLI R08:  python -m ml.civic_classifier <команда>

  build-corpus            пересобрать закреплённый синтетический корпус и split (детерминированно)
  train [--out DIR]       обучить NB и логистическую регрессию, выбрать по validation, сохранить data/model.json.gz
  evaluate [--out DIR]    метрики сохранённой модели на test и пробном наборе + эвристика (без переобучения)
  predict TEXT [--language ru|kk|unknown]   classify() одного сообщения (JSON)
  info                    версия/хэши загруженной модели
  audit [--out DIR]       раунд 13: воспроизведение (sha256) и аудит утечек splits -> audit.json
  protocol --sets cv,test,probe | challenge [--out DIR]   раунд 13: честное сравнение (PROTOCOL.md)
  report13 [--dir DIR]    раунд 13: EXPERIMENT_REPORT.md из сохранённых JSON
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parents[2] / "research" / "round-12-results" / "R08"
RESULTS13 = Path(__file__).resolve().parents[2] / "research" / "round-13-results" / "R08"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ml.civic_classifier")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build-corpus")
    t = sub.add_parser("train")
    t.add_argument("--out", default=str(RESULTS))
    e = sub.add_parser("evaluate")
    e.add_argument("--out", default=str(RESULTS))
    p = sub.add_parser("predict")
    p.add_argument("text")
    p.add_argument("--language", default=None)
    sub.add_parser("info")
    a = sub.add_parser("audit")
    a.add_argument("--out", default=str(RESULTS13))
    pr = sub.add_parser("protocol")
    pr.add_argument("--sets", default="cv,test,probe")
    pr.add_argument("--out", default=str(RESULTS13))
    rr = sub.add_parser("report13")
    rr.add_argument("--dir", default=str(RESULTS13))
    args = ap.parse_args(argv)
    if args.cmd == "build-corpus":
        from ml.civic_classifier.corpus import build
        m = build()
        print(json.dumps({k: m[k] for k in ("corpus_sha256", "rows", "templates", "removed", "anonymized_markers")},
                         ensure_ascii=False, indent=1))
    elif args.cmd == "train":
        from ml.civic_classifier.train import train
        s = train(report_path=Path(args.out) / "train_report.json")
        print(json.dumps({k: s[k] for k in ("version", "kind", "threshold", "payload_sha256", "file_sha256",
                                            "vocab_size", "train_rows", "val_rows")}, ensure_ascii=False, indent=1))
    elif args.cmd == "evaluate":
        from ml.civic_classifier.evaluate import evaluate
        r = evaluate(Path(args.out))
        print(json.dumps(r["headline"], ensure_ascii=False, indent=1))
    elif args.cmd == "predict":
        from ml.civic_classifier import classify
        from ml.civic_classifier.text import detect_language
        lang = args.language or detect_language(args.text)
        print(json.dumps(classify(args.text, lang), ensure_ascii=False))
    elif args.cmd == "audit":
        from ml.civic_classifier.audit import audit
        rep = audit()
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "audit.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(json.dumps({"reproduction_identical": rep["reproduction"]["identical"],
                          "leakage": rep["leakage"]["per_split"]}, ensure_ascii=False, indent=1))
    elif args.cmd == "protocol":
        from ml.civic_classifier.protocol import run
        r = run([x for x in args.sets.split(",") if x], Path(args.out))
        print(json.dumps({k: r[k] for k in ("policy",)}, ensure_ascii=False))
    elif args.cmd == "report13":
        from ml.civic_classifier.report13 import build
        d = Path(args.dir)
        (d / "EXPERIMENT_REPORT.md").write_text(build(d), encoding="utf-8")
        print(d / "EXPERIMENT_REPORT.md")
    elif args.cmd == "info":
        from ml.civic_classifier import model_info
        print(json.dumps(model_info(), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
