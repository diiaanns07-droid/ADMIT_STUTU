#!/usr/bin/env python3
"""Extract source files from NN_HANDOFF.txt (ASHEN_V1 protocol) for integration by #1.

    python tools/extract_handoff.py path/to/02_HANDOFF.txt [more ...] [--out handoff_extracted]

Every block
    === FILE: name.js ===
    ...source...
    === END FILE ===
is written to <out>/<NN>/<name>. Nothing in modules/ is overwritten: the integrator
reviews, adapts and copies files deliberately.

Big existing files may come as PATCH blocks instead of full files (ASHEN_V2 protocol):
    === PATCH: modules/combat.js ===
    <<<<<<< SEARCH
    ...exact current lines...
    =======
    ...new lines...
    >>>>>>> REPLACE
    (more SEARCH/REPLACE pairs)
    === END PATCH ===
With --root ROOT every SEARCH chunk is checked against ROOT/<path> (must occur exactly once,
applied in order) and the patched copy is written to <out>/<NN>/<path> for review. A report lists API_VERSION, the
files found, the export names of each JS file and anything suspicious
(truncation markers, Markdown fences, missing END FILE).
"""
import argparse
import os
import re
import sys

FILE_RE = re.compile(r"^=== FILE:\s*(.+?)\s*===\s*$")
END_RE = re.compile(r"^=== END FILE ===\s*$")
PATCH_RE = re.compile(r"^=== PATCH:\s*(.+?)\s*===\s*$")
END_PATCH_RE = re.compile(r"^=== END PATCH ===\s*$")
EXPORT_RE = re.compile(r"^\s*export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)", re.M)
SUSPICIOUS = [
    (re.compile(r"^```", re.M), "Markdown fence inside source"),
    (re.compile(r"остальное без изменений|rest unchanged|\.\.\. ?\(|// \.\.\.$", re.I | re.M), "possible truncation marker"),
]


def parse_patch(lines):
    """[(search, replace)] из строк блока PATCH; ошибки формата — в список problems."""
    pairs, problems, mode, a, b = [], [], None, [], []
    for line in lines:
        t = line.rstrip()
        if t == "<<<<<<< SEARCH":
            if mode is not None:
                problems.append("SEARCH внутри незакрытой пары")
            mode, a, b = "s", [], []
        elif t == "=======" and mode == "s":
            mode = "r"
        elif t == ">>>>>>> REPLACE" and mode == "r":
            pairs.append(("\n".join(a), "\n".join(b)))
            mode = None
        elif mode == "s":
            a.append(line)
        elif mode == "r":
            b.append(line)
        elif t:
            problems.append(f"строка вне пары SEARCH/REPLACE: {t[:60]}")
    if mode is not None:
        problems.append("последняя пара SEARCH/REPLACE не закрыта")
    return pairs, problems


def apply_patch(src_text, pairs):
    text, problems = src_text.replace("\r\n", "\n"), []
    for i, (a, b) in enumerate(pairs, 1):
        n = text.count(a) if a else 0
        if n != 1:
            problems.append(f"пара {i}: SEARCH найден {n} раз(а) — нужно ровно 1")
            continue
        text = text.replace(a, b, 1)
    return text, problems


def extract(path, out_root, root=None):
    name = os.path.basename(path)
    m = re.match(r"(\d\d)_", name)
    tag = m.group(1) if m else os.path.splitext(name)[0]
    with open(path, encoding="utf-8-sig") as fh:
        lines = fh.read().splitlines()
    api = next((l.strip() for l in lines if "API_VERSION" in l), "API_VERSION not found")
    files, cur, buf, problems = [], None, [], []
    patches, pcur, pbuf = [], None, []
    for i, line in enumerate(lines, 1):
        pm = PATCH_RE.match(line)
        if pm and cur is None:
            pcur, pbuf = pm.group(1).strip(), []
            continue
        if pcur is not None and END_PATCH_RE.match(line):
            patches.append((pcur, pbuf))
            pcur, pbuf = None, []
            continue
        if pcur is not None:
            pbuf.append(line)
            continue
        fm = FILE_RE.match(line)
        if fm:
            if cur:
                problems.append(f"line {i}: FILE '{fm.group(1)}' starts before END of '{cur}'")
                files.append((cur, buf))
            cur, buf = fm.group(1).strip(), []
            continue
        if END_RE.match(line):
            if cur is None:
                problems.append(f"line {i}: END FILE without FILE")
            else:
                files.append((cur, buf))
            cur, buf = None, []
            continue
        if cur is not None:
            buf.append(line)
    if cur:
        problems.append(f"'{cur}': missing END FILE (file kept, may be truncated)")
        files.append((cur, buf))

    out_dir = os.path.join(out_root, tag)
    os.makedirs(out_dir, exist_ok=True)
    report = [f"# {name}", f"- {api}", f"- files: {len(files)}"]
    for fname, body in files:
        safe = os.path.normpath(fname).replace("\\", "/")
        if safe.startswith("../") or os.path.isabs(safe):
            problems.append(f"unsafe path skipped: {fname}")
            continue
        text = "\n".join(body).rstrip("\n") + "\n"
        dest = os.path.join(out_dir, safe)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        exports = EXPORT_RE.findall(text) if safe.endswith((".js", ".mjs")) else []
        report.append(f"  - {safe}: {len(body)} lines" + (f"; exports: {', '.join(exports)}" if exports else ""))
        for rx, msg in SUSPICIOUS:
            if rx.search(text):
                problems.append(f"{safe}: {msg}")
    if pcur is not None:
        problems.append(f"PATCH '{pcur}': missing END PATCH")
        patches.append((pcur, pbuf))
    for pname, body in patches:
        safe = os.path.normpath(pname).replace("\\", "/")
        if safe.startswith("../") or os.path.isabs(safe):
            problems.append(f"unsafe patch path skipped: {pname}")
            continue
        pairs, perr = parse_patch(body)
        problems += [f"PATCH {safe}: {e}" for e in perr]
        info = f"  - PATCH {safe}: {len(pairs)} пар(ы) SEARCH/REPLACE"
        if root:
            src = os.path.join(root, safe)
            if not os.path.exists(src):
                problems.append(f"PATCH {safe}: исходного файла нет в {root}")
            else:
                with open(src, encoding="utf-8") as fh:
                    patched, aerr = apply_patch(fh.read(), pairs)
                problems += [f"PATCH {safe}: {e}" for e in aerr]
                dest = os.path.join(out_dir, safe)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(patched)
                info += "; применён к копии" + (" с ошибками" if aerr else "")
        report.append(info)
    report += [f"  ! {p}" for p in problems] or ["  (no problems detected)"]
    return "\n".join(report)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("handoffs", nargs="+")
    ap.add_argument("--out", default="handoff_extracted")
    ap.add_argument("--root", default=None, help="корень проекта: проверить и применить PATCH к копиям")
    args = ap.parse_args()
    reports = [extract(p, args.out, args.root) for p in args.handoffs]
    text = "\n\n".join(reports)
    with open(os.path.join(args.out, "EXTRACT_REPORT.md"), "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
