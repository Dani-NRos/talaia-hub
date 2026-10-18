# Compara dos carpetas de capturas: textos y localStorage idénticos; imágenes con tolerancia de suavizado.
import sys, glob, os
from PIL import Image, ImageChops
a, b = sys.argv[1], sys.argv[2]
bad = 0
names = sorted(set(os.listdir(a)) | set(os.listdir(b)))
for n in names:
    pa, pb = os.path.join(a, n), os.path.join(b, n)
    if not (os.path.exists(pa) and os.path.exists(pb)):
        print("FALTA", n); bad += 1; continue
    if n.endswith(".png"):
        ia, ib = Image.open(pa).convert("RGB"), Image.open(pb).convert("RGB")
        if ia.size != ib.size:
            print("TAMAÑO", n, ia.size, ib.size); bad += 1; continue
        d = ImageChops.difference(ia, ib).convert("L").point(lambda v: 255 if v > 60 else 0)
        k = sum(1 for v in d.getdata() if v)
        if k > 30:
            print("IMAGEN", n, k, "píxeles", d.getbbox()); bad += 1
    elif n != "errores.txt":
        if open(pa, encoding="utf8").read() != open(pb, encoding="utf8").read():
            print("TEXTO", n); bad += 1
print("IGUALES" if not bad else f"{bad} diferencias")
