import re, math, json, csv, sys
sys.path.insert(0, '.')
from data import G

FAM = [
  ("mohair", r"mohair"), ("alpakka", r"alpakk|alpaca"), ("kasjmir", r"kasjmir|cashmere"),
  ("silke", r"silke|silk"), ("bomull", r"bomull|pima"), ("lin", r"\blin\b"),
  ("viskose", r"viskose"), ("syntetisk", r"nylon|polyamid|akryl|polyester|metall"),
  ("merino", r"merino"), ("ull", r"ull|lammeull|lamull|tweed"),
]
def fibre(s):
    s = s.lower()
    out = {}
    parts = re.findall(r"(\d+)\s*%\s*([^,%]+?)(?=,|\s+og\s+\d|\s+\d+\s*%|$)", s)
    if not parts:  # «100 % alpakka» fanges over; ellers hele teksten som én fiber
        parts = [("100", s)]
    for pct, name in parts:
        fam = next((f for f, rx in FAM if re.search(rx, name)), "annet")
        out[fam] = out.get(fam, 0) + int(pct)
    tot = sum(out.values()) or 1
    return {k: v * 100 / tot for k, v in out.items()}

Y = []
for prod, navn, g, m, gr, fib in G:
    Y.append(dict(produsent=prod, garn=navn, gauge=g, mpg=m/gr, m=m, gr=gr, fiber=fib, fam=fibre(fib)))

def overlap(a, b):
    # Merino og annen ull er samme fiber, men kjennes ulikt (myk mot rustikk): halv likhet på tvers.
    lik = sum(min(a.get(k, 0), b.get(k, 0)) for k in set(a) | set(b))
    a_rest = {k: a.get(k, 0) - min(a.get(k, 0), b.get(k, 0)) for k in ("merino", "ull")}
    b_rest = {k: b.get(k, 0) - min(a.get(k, 0), b.get(k, 0)) for k in ("merino", "ull")}
    lik += 0.5 * (min(a_rest["merino"], b_rest["ull"]) + min(a_rest["ull"], b_rest["merino"]))
    return lik

def gap(a, b):
    if a is None or b is None: return None
    return max(0, max(a[0], b[0]) - min(a[1], b[1]))

def lace(y):  # følgetråd / lace: holdes ofte sammen med et annet garn
    return y["mpg"] >= 6.5

res = {}
for a in Y:
    cands = []
    for b in Y:
        if a is b: continue
        if lace(a) != lace(b): continue
        ov = overlap(a["fam"], b["fam"])
        if ov < 50: continue
        ratio = b["mpg"] / a["mpg"]
        if not (0.8 <= ratio <= 1.25): continue
        gp = gap(a["gauge"], b["gauge"])
        if gp is not None and gp > 1: continue
        if gp is None and not lace(a): continue  # uten strikkefasthet: bare følgetråder sammenlignes
        # Samme garn under to navn: samme produsent, samme fiber og samme spesifikasjoner (PetiteKnit-utgavene, Bella/Bella Color)
        kjerne = lambda n: re.sub(r"petiteknit|color", "", n.lower()).strip()
        same = kjerne(a["garn"]) == kjerne(b["garn"]) and a["produsent"] == b["produsent"] and a["fiber"].replace(" ", "").lower() == b["fiber"].replace(" ", "").lower() and a["m"] == b["m"] and a["gr"] == b["gr"] and gp in (0, None)
        if same: niva = "Samme garn"
        elif (gp in (0, None)) and abs(ratio - 1) <= 0.1 and ov >= 80: niva = "Svært lik"
        else: niva = "Lik"
        score = (0 if same else 1 if niva == "Svært lik" else 2, gp or 0, abs(math.log(ratio)), -ov)
        cands.append((score, niva, b, round(ov), gp))
    cands.sort(key=lambda c: c[0])
    res[(a["produsent"], a["garn"])] = cands[:6]

def gtxt(g):
    return "–" if g is None else (f"{g[0]}" if g[0] == g[1] else f"{g[0]}–{g[1]}")

rows = []
for a in Y:
    for score, niva, b, ov, gp in res[(a["produsent"], a["garn"])]:
        rows.append({
            "garn": f'{a["produsent"]} {a["garn"]}', "strikkefasthet": gtxt(a["gauge"]), "m_per_50g": round(a["mpg"]*50),
            "fiber": a["fiber"], "lignende": f'{b["produsent"]} {b["garn"]}', "niva": niva,
            "lignende_strikkefasthet": gtxt(b["gauge"]), "lignende_m_per_50g": round(b["mpg"]*50),
            "lignende_fiber": b["fiber"], "fiberlikhet_pct": ov,
        })
with open("lignende_garn.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
json.dump({"garn": [dict(produsent=a["produsent"], garn=a["garn"], strikkefasthet=gtxt(a["gauge"]), m50=round(a["mpg"]*50), fiber=a["fiber"],
    lignende=[dict(navn=f'{b["produsent"]} {b["garn"]}', niva=n, strikkefasthet=gtxt(b["gauge"]), m50=round(b["mpg"]*50), fiber=b["fiber"], fiberlikhet=ov)
              for _, n, b, ov, _g in res[(a["produsent"], a["garn"])]]) for a in Y]}, open("lignende_garn.json", "w"), ensure_ascii=False, indent=1)
uten = [f'{a["produsent"]} {a["garn"]}' for a in Y if not res[(a["produsent"], a["garn"])]]
print(len(rows), "par;", len(Y) - len(uten), "av", len(Y), "garn har minst ett lignende")
print("Uten lignende:", "; ".join(uten))
for a in Y:
    r = res[(a["produsent"], a["garn"])]
    print(f'{a["produsent"]} {a["garn"]} [{gtxt(a["gauge"])} m, {round(a["mpg"]*50)} m/50g]: ' + ", ".join(f'{b["garn"]} ({b["produsent"]}, {n})' for _, n, b, ov, gp in r))
