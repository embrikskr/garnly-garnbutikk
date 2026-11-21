# Lignende garn (21.11.2026)

Grunnlaget for forslaget i handlekurven: «bytt garn X med lignende garn Y og spar 79 kr i frakt»,
når ordren ellers må sendes fra to butikker (79 kr per butikk, se STATUS 21.11).

- `data.py` – Garnlys 93 aktive garn med strikkefasthet, løpelengde, vekt og fiber, lest fra
  metafeltene i Shopify (`garnly.strikkefasthet`, `lopelengde_m`, `vekt_g`, `fiber`) 21.11.2026.
- `match.py` – regelen. Kjør `python3 -I match.py` i denne mappa; den skriver `lignende_garn.csv`.
- `lignende_garn.csv` – resultatet: opptil seks lignende garn per garn, med nivå og fiberlikhet.
- Oversikten for Embrik og Halvor: https://claude.ai/artifact/Hbn4zpToPkJYLops2rHmgA

**Regelen** (etter Yarnmatch: «nesten samme strikkefasthet og løpelengde»):
strikkefasthet innen én maske per 10 cm; løpelengde per gram innen ±20 %; fiber minst 50 % lik
(merino mot annen ull teller halvt); følgetråder (≥ 325 m per 50 g) bare mot hverandre.
Nivå: «Samme garn» (samme garn under to navn, f.eks. Sunday / SUNDAY PetiteKnit),
«Svært lik» (samme fasthet, ±10 % løpelengde, ≥ 80 % lik fiber), ellers «Lik».

Yarnmatch-dataene (katalog_yarns.json, garn.csv, 163 garn) ligger i den delte disken. De har
også følelse (varme, mykhet, kløing, tyngde), men bare for noen få av Garnlys garn.

Ikke bestemt ennå: om lista skal godkjennes av Halvor før den brukes, hvor den skal ligge
(metafelt på produktet eller tabell her), og hvordan forslaget vises i handlekurven.
