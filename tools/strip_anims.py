#!/usr/bin/env python3
"""[HERO] Библиотека анимаций из GLB: оставляет скелет (узлы) и выбранные клипы, убирает
меши, скины, материалы и текстуры. Бинарный кусок пересобирается только из аксессоров клипов.

Использование:  python tools/strip_anims.py in.glb out.glb Idle Walking_A Running_A ...
                python tools/strip_anims.py in.glb --list
Нужен только стандартный Python.
"""
import json
import struct
import sys


def read_glb(path):
    data = open(path, "rb").read()
    magic, _version, length = struct.unpack_from("<III", data, 0)
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
        f.write(struct.pack("<II", len(jb), 0x4E4F534A))
        f.write(jb)
        f.write(struct.pack("<II", len(binc), 0x004E4942))
        f.write(binc)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    js, binc = read_glb(sys.argv[1])
    anims = js.get("animations", [])
    if sys.argv[2] == "--list":
        for a in anims:
            print(a.get("name"))
        return
    keep = sys.argv[3:]
    by_name = {a.get("name", "").split("|")[-1]: a for a in anims}
    missing = [k for k in keep if k not in by_name]
    if missing:
        print("нет клипов:", missing)
    sel = [by_name[k] for k in keep if k in by_name]
    # только деформирующие кости (без IK-контроллеров): узлы с именами из DEFORM, если заданы
    names = [n.get("name", "") for n in js["nodes"]]
    ctrl = ("IK", "control-", "kneeIK", "heelIK", "elbowIK", "handIK")
    for a in sel:
        chans = [c for c in a["channels"] if not any(t in names[c["target"]["node"]] for t in ctrl)]
        used = sorted({c["sampler"] for c in chans})
        sm = {o: i for i, o in enumerate(used)}
        a["samplers"] = [a["samplers"][o] for o in used]
        for c in chans:
            c["sampler"] = sm[c["sampler"]]
        a["channels"] = chans
    # аксессоры клипов → новые bufferViews подряд
    acc_old = js["accessors"]
    views_old = js["bufferViews"]
    new_acc, new_views, remap = [], [], {}
    blob = bytearray()
    for a in sel:
        for s in a["samplers"]:
            for key in ("input", "output"):
                i = s[key]
                if i not in remap:
                    acc = dict(acc_old[i])
                    v = views_old[acc["bufferView"]]
                    start = v.get("byteOffset", 0) + acc.get("byteOffset", 0)
                    comp = {5126: 4, 5123: 2, 5125: 4, 5121: 1, 5122: 2, 5120: 1}[acc["componentType"]]
                    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc["type"]]
                    stride = v.get("byteStride", comp * ncomp)
                    size = comp * ncomp
                    raw = bytearray()
                    for k in range(acc["count"]):
                        raw += binc[start + k * stride: start + k * stride + size]
                    while len(blob) % 4:
                        blob += b"\0"
                    new_views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(raw)})
                    blob += raw
                    acc["bufferView"] = len(new_views) - 1
                    acc.pop("byteOffset", None)
                    acc.pop("sparse", None)
                    if key == "output":
                        acc.pop("min", None)
                        acc.pop("max", None)
                    remap[i] = len(new_acc)
                    new_acc.append(acc)
                s[key] = remap[i]
    for n in js["nodes"]:
        n.pop("mesh", None)
        n.pop("skin", None)
    for k in ("meshes", "skins", "materials", "textures", "images", "samplers"):
        js.pop(k, None)
    js["animations"] = sel
    js["accessors"] = new_acc
    js["bufferViews"] = new_views
    js["buffers"] = [{"byteLength": len(blob)}]
    js.pop("extensionsUsed", None)
    js.pop("extensionsRequired", None)
    write_glb(sys.argv[2], js, bytes(blob))
    print(f"{len(sel)} клипов, {len(blob)} байт данных")


if __name__ == "__main__":
    main()
