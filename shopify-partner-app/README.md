# Garnly-appen for partnerbutikker (egen Shopify)

Utenlandske partnerbutikker har lageret sitt i egen Shopify. Butikker kan ikke lenger lage
API-nøkler i Shopify-admin selv (stengt januar 2026), så de installerer denne appen. Den får lese
produkter, lager og lokasjoner, og opprette ordrer merket «Garnly». Den endrer aldri produkter eller
priser.

**Én app per butikk.** En app med «custom distribution» kan bare installeres i én butikk, så hver
ny partnerbutikk får sin egen app med egen klient-id og -hemmelighet. Det tar fem minutter.
Innloggingen gjøres av Edge Function `shopify-install`; koden er i `_shared/shopify_oauth.ts` og
`_shared/partner_shop.ts`.

## Ny partnerbutikk

1. **Butikken i databasen.** Raden i `stores` må finnes før de installerer, med
   `pos_system = 'shopify'`, `active = false` og `pos_config = {"shop_domain": "navn.myshopify.com"}`.
2. **Lag appen** på https://dev.shopify.com/dashboard (Garnlys konto):
   - *Create app* → *Start from Dev Dashboard* → navn: `Garnly`
   - *Versions → Create version*:
     - App URL: `https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/shopify-install`
     - Embed app in Shopify admin: **av**
     - Scopes: `read_products,read_inventory,read_locations,write_orders`
     - Use legacy install flow: **på**
     - Redirect URLs: samme adresse som App URL
     - *Release*
   - *Distribution* → *Custom distribution* → butikkens `navn.myshopify.com` → *Generate link*
3. **Klient-id og -hemmelighet** (*Settings* i appen) legges i `store_secrets` for butikken:
   `{"app": {"client_id": "...", "client_secret": "..."}}`. Aldri i kode eller `pos_config`.
4. **Send installasjonslenken** til butikken. De logger inn i Shopify, trykker *Install* og
   godkjenner tilgangen. Siden de lander på sier «Garnly er koblet til …».
5. **Sjekk:** `store_secrets.secrets->'shopify'` har `access_token` og `refresh_token`, og
   `audit_log` har `shopify_app_installed` uten noe under `mangler`.

Nøkkelen utløper etter én time og fornyes automatisk (`partnerAccessToken`). Fornyingsnøkkelen
varer i 90 dager og fornyes hver gang den brukes, så den går bare ut hvis butikken ikke har vært
synket på tre måneder. Da må butikken åpne Garnly-appen i Shopify på nytt.

Trenger appen flere tilganger senere: legg dem til i `PARTNER_SCOPES` og i en ny versjon i Dev
Dashboard. Butikken åpner da appen i Shopify og godkjenner på nytt.
