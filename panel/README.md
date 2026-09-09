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

## Sett opp

1. Fyll inn `SUPABASE_ANON_KEY` i `config.js` (Supabase → Project settings → API).
2. Legg til et `icon.png` på 512×512 i denne mappen, ellers faller ikonet tilbake
   på nettleserens standard når butikken legger panelet på hjemskjermen.
3. Deploy mappen som en statisk side:

   **Cloudflare Pages**
   ```bash
   npx wrangler pages deploy panel --project-name garnly-butikkpanel
   ```

   **Vercel**
   ```bash
   npx vercel deploy panel --prod
   ```

4. Pek `butikk.garnly.no` mot prosjektet (CNAME i DNS).
5. Sett `PANEL_ORIGIN=https://butikk.garnly.no` som secret på Supabase, slik at
   CORS i `offer-respond` slipper gjennom bare den adressen:
   ```bash
   supabase secrets set PANEL_ORIGIN=https://butikk.garnly.no
   ```

## Gi en butikk tilgang

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
