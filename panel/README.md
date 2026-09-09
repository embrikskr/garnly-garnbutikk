# Garnly butikkpanel

Siden butikkene har oppe på nettbrettet ved pakkebordet. Den viser nye ordrer i
sanntid, og de svarer med Godta eller Avslå. Ingen e-post per ordre.

## Hvordan det henger sammen

- Leser direkte fra Supabase med anon-nøkkelen. RLS og `store_users` gjør at en
  innlogget bruker bare ser sin egen butikks tilbud (`004_store_panel.sql`).
- Sanntid via `postgres_changes` på `offers`. Faller den ut, henter panelet på nytt
  hvert 30. sekund uansett, og viser en rød prikk i toppen.
- Godta og avslå går til Edge Function `offer-respond` med brukerens JWT.
  All logikk (live lagersjekk mot kassa, flytting av fulfillment order i Shopify,
  slipp av hold, fraktbooking) skjer på serveren. Panelet er bare skallet.

## Hvor det kjører

**https://garnly-butikkpanel.vercel.app**

Vercel-prosjekt med Root Directory `panel/`, framework «Other», ingen build-kommando.
`vercel.json` setter `outputDirectory` til `.`, som er det som hindrer feilen
«No Output Directory named public». Git-push deployer.

`PANEL_ORIGIN` på Supabase peker hit, og `offer-respond` slipper bare gjennom denne
adressen. Bytter adressen, må secreten oppdateres og funksjonen deployes på nytt.

Panelet trenger ingen miljøvariabler i Vercel. Supabase-URL og anon-nøkkel står i
`config.js` og er ment å være offentlige; RLS gjør jobben. Legg aldri service
role-nøkkelen eller Shopify-secretene inn i dette prosjektet.

Skal `butikk.garnly.no` brukes: legg den til under Settings → Domains, sett CNAME-en
Vercel oppgir, og oppdater `PANEL_ORIGIN`.

### Ikon

Legg et `icon.png` på 512×512 i denne mappen, ellers faller ikonet tilbake på
nettleserens standard når butikken legger panelet på hjemskjermen.

## Gi en butikk tilgang

Strikkefryd og Garnkilden har allerede hver sin bruker, koblet i `store_users`.
Passordene er delt med Embrik direkte og bør byttes av butikkene selv.

For en ny butikk:

1. Supabase → Authentication → Users → Add user. E-post og passord til butikken.
2. Koble brukeren til butikken:
   ```sql
   insert into store_users (user_id, store_id, role)
   values ('<auth user id>', (select id from stores where slug = 'strikkefryd'), 'owner');
   ```
3. Send dem adressen. På iPad: Del → Legg til på Hjem-skjerm. Da åpner panelet seg
   uten adressefelt og ser ut som en app.

Sesjonen fornyer seg selv, så nettbrettet forblir innlogget til noen logger ut.

## Test lokalt

```bash
python3 -m http.server 5173 --directory panel
```
Åpne http://localhost:5173. Husk å legge til `http://localhost:5173` under
Supabase → Authentication → URL configuration hvis du tester innlogging.
