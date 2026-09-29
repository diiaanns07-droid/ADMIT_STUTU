#!/usr/bin/env python3
"""Уменьшает VRM/GLB для веба: текстуры > max_side уменьшаются, непрозрачные
перекодируются в JPEG, с прозрачностью — в PNG (опционально квантуются).
Геометрия, скелет, морфы и расширения VRM не меняются: пересобирается только
бинарный кусок (bufferViews изображений заменяются, смещения пересчитываются).

Использование:  python tools/shrink_vrm.py in.vrm out.vrm [--max 1024] [--jpeg 85]
Нужен Pillow.
"""
import argparse
import io
import json
import struct

from PIL import Image


def read_glb(path):
    data = open(path, "rb").read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "не GLB"
    off = 12
    js = binc = None
    while off < length:
        clen, ctype = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode("utf-8"))
        elif ctype == 0x004E4942:
            binc = chunk
        off += 8 + clen
    return js, binc


def write_glb(path, js, binc):
    jb = json.dumps(js, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    jb += b" " * ((4 - len(jb) % 4) % 4)
    binc += b"\0" * ((4 - len(binc) % 4) % 4)
    total = 12 + 8 + len(jb) + 8 + len(binc)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(jb), 0x4E4F534A)); f.write(jb)
        f.write(struct.pack("<II", len(binc), 0x004E4942)); f.write(binc)


def shrink_image(raw, max_side, jpeg_q):
    im = Image.open(io.BytesIO(raw))
    im.load()
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    if has_alpha:
        im = im.convert("RGBA")
        lo, hi = im.getchannel("A").getextrema()
        if lo >= 250:
            has_alpha = False
    w, h = im.size
    k = min(1.0, max_side / max(w, h))
    if k < 1.0:
        im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    out = io.BytesIO()
    if has_alpha:
        im.save(out, "PNG", optimize=True)
        return out.getvalue(), "image/png"
    im.convert("RGB").save(out, "JPEG", quality=jpeg_q, optimize=True, progressive=False)
    return out.getvalue(), "image/jpeg"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--max", type=int, default=1024)
    ap.add_argument("--jpeg", type=int, default=85)
    a = ap.parse_args()
    js, binc = read_glb(a.src)
    views = js["bufferViews"]
    img_view = {}
    for i, img in enumerate(js.get("images", [])):
        if "bufferView" in img:
            raw_v = views[img["bufferView"]]
            s = raw_v.get("byteOffset", 0)
            raw = binc[s: s + raw_v["byteLength"]]
            new, mime = shrink_image(raw, a.max, a.jpeg)
            img_view[img["bufferView"]] = new
            img["mimeType"] = mime
    # пересобрать BIN: все bufferViews по порядку, выравнивание 4 байта
    out = bytearray()
    for vi, v in enumerate(views):
        s = v.get("byteOffset", 0)
        blob = img_view.get(vi, binc[s: s + v["byteLength"]])
        out += b"\0" * ((4 - len(out) % 4) % 4)
        v["byteOffset"] = len(out)
        v["byteLength"] = len(blob)
        out += blob
    js["buffers"][0]["byteLength"] = len(out)
    write_glb(a.dst, js, bytes(out))
    print(f"{a.src}: {len(binc) / 1e6:.1f} MB -> {len(out) / 1e6:.1f} MB, images {len(img_view)}")


if __name__ == "__main__":
    main()
