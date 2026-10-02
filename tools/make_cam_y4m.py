# [PERF] Синтетическое видео для поддельной камеры Chromium (tools/perf_bench.mjs --video):
#   python tools/make_cam_y4m.py %TEMP%/cam_640x480_30.y4m
# 640×480, 30 к/с, 3 с (≈41 МБ, файл не в репозитории). Человека в кадре нет (ничьё видео не используется):
# тёмное подвижное пятно на светлом фоне — худший случай для MediaPipe (детекторы позы и ладоней работают
# каждый кадр и ничего не находят). Встроенная поддельная камера Chromium даёт 20 к/с, а в Edge на встроенной
# AMD — кадры 2×2, поэтому для сравнимых замеров нужен файл. Нужен Pillow.
import math
import sys

from PIL import Image, ImageDraw

W, H, FPS, SEC = 640, 480, 30, 3
out = sys.argv[1] if len(sys.argv) > 1 else 'cam_640x480_30.y4m'
with open(out, 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
    for i in range(FPS * SEC):
        t = i / FPS
        im = Image.new('RGB', (W, H), (170, 160, 150))
        d = ImageDraw.Draw(im)
        for y in range(0, H, 8):
            k = int(120 + 50 * y / H)
            d.line([(0, y), (W, y)], fill=(k, k - 10, k - 20), width=8)
        cx = W // 2 + int(60 * math.sin(t * 1.3))
        cy = H // 2 + int(20 * math.sin(t * 0.7))
        d.ellipse([cx - 70, cy - 40, cx + 70, cy + 200], fill=(60, 50, 55))
        d.ellipse([cx - 35, cy - 110, cx + 35, cy - 30], fill=(140, 110, 95))
        d.rectangle([cx - 150 + int(30 * math.sin(t * 2)), cy + 10, cx - 90, cy + 40], fill=(140, 110, 95))
        d.rectangle([cx + 90, cy + 10 + int(25 * math.cos(t * 2)), cx + 150, cy + 40], fill=(140, 110, 95))
        ycc = im.convert('YCbCr')
        yb, cb, cr = ycc.split()
        f.write(b'FRAME\n')
        f.write(yb.tobytes())
        f.write(cb.resize((W // 2, H // 2), Image.BILINEAR).tobytes())
        f.write(cr.resize((W // 2, H // 2), Image.BILINEAR).tobytes())
print(out)
