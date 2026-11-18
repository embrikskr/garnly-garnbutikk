# Garnly Shopify-app: kassevalidering («ett parti fra én butikk»)

Shopify Function (Cart and Checkout Validation, byggeplan §7) som blokkerer kjøp der **ingen enkelt
butikk i kundens land** har hele antallet av en varelinje. Den leser metafeltet `garnly.stock_by_store`
(JSON med `{"NO:<location-gid>": antall, "DK:<location-gid>": antall}`) som `sync-store` skriver på
hver variant ved hver lagersynk, bare for aktive butikker.

**Aldri over tollgrensen (18.11.2026):** bare lokasjoner i kundens land teller. Landet er
leveringsadressens (`cart.deliveryGroups.deliveryAddress.countryCode`), ellers markedets
(`localization.country`), ellers Norge. Nøkler uten land (skrevet før 18.11.2026) regnes som norske.

**Status 18.11.2026: funksjonen er ikke deployet, og ingen kasseregel er aktiv i Garnlys Shopify**
(`validations` er tom). Den må deployes med Shopify CLI (under) og slås på før danske butikker
aktiveres.

Funksjonen sjekker IKKE at én butikk har hele kurven — det er rutingens jobb (§8.2). Varianter uten
metafelt blokkeres aldri (ingen lagerdata → slipp gjennom, ruting eskalerer heller i etterkant).

## Deploy (krever Shopify CLI og partner-/butikktilgang)

```bash
npm i -g @shopify/cli@latest
cd shopify-app
shopify app config link      # koble til (eller opprett) appen i Garnlys butikk
shopify app deploy
```

Aktiver deretter valideringen i Shopify admin: **Settings → Checkout → Checkout rules** → legg til
«Garnly parti-validering». Husk å huke av for at valideringen skal blokkere (ikke bare advare).

`shopify.app.toml` her er et utgangspunkt — `shopify app config link` fyller inn `client_id` m.m.

## Test

```bash
node --test "extensions/parti-validering/test/*.test.mjs"
```
