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

Panelet kjøres midlertidig av Edge Function `panel`, som har filene bakt inn:

**https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/panel**

Det er en mellomløsning. Supabase krever et betalt tillegg for eget domene på
funksjoner, så `butikk.garnly.no` kan ikke peke hit. Panelet skal over på Vercel,
der domenet er gratis og resten av frontendene allerede ligger.

### Flytt til Vercel

1. Vercel → Add New → Project → importer `embrikskr/garnly-garnbutikk`.
2. **Root Directory: `panel`**. Framework Preset: Other. Ingen build-kommando.
   `panel/vercel.json` setter allerede `outputDirectory` til `.`, som er det som
   hindrer feilen «No Output Directory named public».
3. Deploy. Legg så til `butikk.garnly.no` under Settings → Domains, og sett CNAME-en
   Vercel oppgir.
4. Si fra om adressen, så settes `PANEL_ORIGIN` og `panel`-funksjonen fjernes.
   To kopier av panelet som kan komme i utakt er verre enn én.

Endrer du noe her, kjør `deno task build-panel` og deploy `panel`-funksjonen på
nytt så lenge den er i bruk. Etter flyttingen til Vercel deployer Git-pushen selv.

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
