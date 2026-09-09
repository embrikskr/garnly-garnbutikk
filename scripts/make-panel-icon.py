"""
Lager panel/icon.png og panel/favicon.ico – Garnly-monogram i husfargene.

Motivet er en «G» i samme vekt som logoen i panelet. Et garnnøste ble prøvd først:
som spiral ble det en grå klump i fanen, og som kryssende ellipser lignet det et
atom. En bokstav holder formen ned til 16 piksler, som er det faviconen faktisk
vises i.

Ikonet er «maskable»: bokstaven ligger innenfor den midtre 80 %-sirkelen, så
Android og iOS kan beskjære til sirkel eller avrundet firkant uten å kutte noe.
Tegnes i 4x og skaleres ned, som gir jevne kanter.

Kjør: python3 scripts/make-panel-icon.py   (krever Pillow)
"""
from PIL import Image, ImageDraw, ImageFont

BG = (95, 11, 9)           # #5F0B09
FG = (247, 242, 234)       # #F7F2EA
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def render(size: int, cap_ratio: float, supersample: int = 4) -> Image.Image:
    n = size * supersample
    img = Image.new("RGB", (n, n), BG)
    d = ImageDraw.Draw(img)

    # Finn punktstørrelsen som gir ønsket høyde på selve bokstaven, ikke på
    # linjeboksen: font-metrikken har luft over og under som ville gjort G-en for liten.
    target = n * cap_ratio
    pt = int(target * 1.35)
    for _ in range(12):
        f = ImageFont.truetype(FONT, pt)
        h = f.getbbox("G")[3] - f.getbbox("G")[1]
        if h == 0:
            break
        pt = max(1, int(pt * target / h))
    font = ImageFont.truetype(FONT, pt)

    # Sentrer på blekket, ikke på tekstankeret.
    x0, y0, x1, y1 = font.getbbox("G")
    d.text(((n - (x1 - x0)) / 2 - x0, (n - (y1 - y0)) / 2 - y0), "G", font=font, fill=FG)
    return img.resize((size, size), Image.LANCZOS)


# 0.52 av flaten: bokstaven får plass i kvadratet som står innskrevet i 80 %-sirkelen.
render(512, cap_ratio=0.52).save("panel/icon.png", optimize=True)

# Faviconen tegnes på nytt per størrelse, ikke nedskalert fra 512. Den får også en
# litt større bokstav, siden det er mindre luft å gå på i en fane.
small = [render(s, cap_ratio=0.62, supersample=8) for s in (16, 32, 48)]
small[-1].save("panel/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)],
               append_images=small[:-1])
print("Skrevet panel/icon.png (512x512) og panel/favicon.ico (16/32/48)")
