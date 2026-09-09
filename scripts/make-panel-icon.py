"""
Lager panel/icon.png og panel/favicon.ico – et garnnøste i Garnly-fargene.

Nøstet er én spiral som fortsetter ut i en løs tråd. Kryssende ellipser ble prøvd
først, men leste som et atom.

To varianter, fordi det som funker på 512 piksler ikke funker på 16: hjemskjerm-
ikonet har tre omdreininger, faviconen halvannen og tykkere tråd. Med tre
omdreininger blir faviconen en grå klump i fanen.

Ikonet er «maskable»: både nøstet og trådspissen ligger innenfor den midtre
80 %-sirkelen, så beskjæring til sirkel eller avrundet firkant kutter ingenting.
Tegnes i 4x og skaleres ned, som gir jevne kanter.

Kjør: python3 scripts/make-panel-icon.py
"""
import math
from PIL import Image, ImageDraw

BG = (95, 11, 9, 255)      # #5F0B09
FG = (247, 242, 234, 255)  # #F7F2EA


def render(size: int, turns: float, width: float, supersample: int = 4) -> Image.Image:
    n = size * supersample
    c = n // 2
    r_ball = int(n * 0.30)      # 60 % av flaten, godt innenfor 80 %-sonen
    w = max(2, int(n * width))

    img = Image.new("RGBA", (n, n), BG)
    d = ImageDraw.Draw(img)
    d.ellipse([c - r_ball, c - r_ball, c + r_ball, c + r_ball], fill=FG)

    def stroke(points, color):
        """Jevn strek. ImageDraw.line(joint="curve") lager knuter når punktene
        ligger tett; tette sirkler gir ren kant etter nedskaleringen."""
        rr = w // 2
        for x, y in points:
            d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=color)

    end = math.radians(35)      # tråden går ut nede til høyre
    t_max = end + 2 * math.pi * turns
    steps = 900
    spiral = []
    for i in range(steps + 1):
        t = t_max * i / steps
        r = r_ball * 0.80 * (t / t_max)
        spiral.append((c + r * math.cos(t_max - t + end), c + r * math.sin(t_max - t + end)))
    stroke(spiral, BG)

    # Løs tråd. Starter i kanten av nøstet, ikke inne i det (spiralen dekker
    # innsiden alt, og mørkt overlapp ga en stygg kile), og stopper innenfor
    # 80 %-sonen så maskable-beskjæring ikke kutter spissen.
    tail = []
    for i in range(401):
        u = i / 400
        a = end + u * math.radians(75)
        r = r_ball * (0.97 + u * 0.31)
        tail.append((c + r * math.cos(a), c + r * math.sin(a)))
    stroke(tail, FG)

    return img.resize((size, size), Image.LANCZOS)


render(512, turns=3.0, width=0.030).convert("RGB").save("panel/icon.png", optimize=True)

# Faviconen tegnes på nytt per størrelse, ikke nedskalert fra 512: en tynn spiral
# skalert til 16 piksler blir grøt uansett hvor pent originalen ser ut.
small = [render(s, turns=1.5, width=0.075, supersample=8) for s in (16, 32, 48)]
small[-1].save("panel/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)],
               append_images=small[:-1])
print("Skrevet panel/icon.png (512x512) og panel/favicon.ico (16/32/48)")
