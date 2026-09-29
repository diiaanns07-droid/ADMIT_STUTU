#!/usr/bin/env python3
"""[BDO] Склейка «до / после» для TEST_REPORT: пары PNG одного имени из двух папок → JPEG рядом.

python tools/bdo_compare.py BEFORE_DIR AFTER_DIR OUT_DIR [name1 name2 ...]
Без имён — все общие файлы. Нужен Pillow (pip install pillow). Ширина половинки — 900 px.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "C:/Windows/Fonts/segoeuib.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 1
    a_dir, b_dir, out = sys.argv[1:4]
    names = sys.argv[4:] or sorted(set(os.listdir(a_dir)) & set(os.listdir(b_dir)))
    os.makedirs(out, exist_ok=True)
    half = 900
    lab = font(22)
    for n in names:
        if not n.endswith(".png"):
            continue
        pa, pb = os.path.join(a_dir, n), os.path.join(b_dir, n)
        if not (os.path.exists(pa) and os.path.exists(pb)):
            print("skip", n)
            continue
        A, B = Image.open(pa).convert("RGB"), Image.open(pb).convert("RGB")
        h = round(A.height * half / A.width)
        A, B = A.resize((half, h), Image.LANCZOS), B.resize((half, round(B.height * half / B.width)), Image.LANCZOS)
        H = max(A.height, B.height)
        S = Image.new("RGB", (half * 2 + 12, H + 40), (12, 10, 8))
        S.paste(A, (0, 40))
        S.paste(B, (half + 12, 40))
        d = ImageDraw.Draw(S)
        d.text((10, 8), "ДО", font=lab, fill=(185, 174, 150))
        d.text((half + 22, 8), "ПОСЛЕ · стиль BDO", font=lab, fill=(216, 179, 106))
        d.text((half * 2 - 380, 8), n.replace(".png", ""), font=font(16), fill=(133, 124, 106))
        dst = os.path.join(out, n.replace(".png", ".jpg"))
        S.save(dst, quality=80, optimize=True)
        print(dst, os.path.getsize(dst) // 1024, "KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
