# Status – garnly-garnbutikk

Oppdatert: 2026-09-30

## Ekte ordre gjennom hele kjeden (30.09.2026, #1004)

Strikkefryd, PostNord pakkeboks via CargonizerConnect. **«Hent fraktetikett (PDF)» virket på
første forsøk** – CargonizerConnect skriver ordrenummeret i avsenders referanse, og oppslaget
traff. Det var det siste ubekreftede punktet i etikettløsningen.

### Feil funnet: «Slått ut i kassa» virket ikke etter sending

`mark_pos_deducted` filtrerte på `status = 'assigned'`. Funksjonen ble skrevet i 013, før
`fulfilled` fantes, og ble glemt da 015/016 innførte statusen – views og TypeScript ble
oppdatert, RPC-en ikke. Butikken fikk «Fant ingen tildelt ordre».

Rekkefølgen som feilet er den vanligste i butikk: pakk → lag sending → slå ut i kassa.
Gruppen er da `fulfilled`, ikke `assigned`.

Rettet i 020. Verifisert ved å utgi seg for butikkbrukeren i SQL, så hele tilgangsveien ble
kjørt og ikke omgått: `pos_deducted_at` satt 19:12:53, `pos_deducted_by`
strikkefryd@garnly.no, dobbelttrykk gir samme tidspunkt, og Garnkilden nektes fortsatt.

De fire tilstandene ligger nå også som ren logikk i `_shared/inventory.ts`
(`pendingForGroup`), med test på nettopp «sendt først, så slått ut». SQL-viewet er fortsatt
implementasjonen; den rene funksjonen er der for at regelen skal være lesbar og testbar –
det var mangelen på det som lot feilen gå upåaktet.

### Sporingsnummer lagres nå

`getOrderFulfillments` henter `trackingInfo`, og `fulfilled_at` lagres sammen med
`tracking_number` og `tracking_url`. Vi oppretter ikke fulfillments selv, så dette er eneste
stedet sporingen finnes. Settes bare når den finnes, så en fulfillment uten sporing ikke
nuller ut en vi alt har. #1004 etterfylt manuelt (PostNord 70727320855841324), siden den ble
merket sendt før endringen.

## Fraktetikett som PDF i panelet (30.09.2026)

Ikke alle butikker har etikettskriver. Sendingen lages fortsatt i CargonizerConnect – vi
oppretter ingenting – men backenden slår den opp i Cargonizer og leverer PDF-en til panelet.

Verifisert mot ekte data 30.09 (sending 76295361, referanse TEST-1002):

| Kall | Resultat |
|---|---|
| `GET /consignments.xml?text=<ordrenummer>` | sendingen, med `<id>` |
| `GET /consignments/label_pdf?consignment_ids[]=<id>` | PDF, også når `state = open` |

Fire ting som ikke er åpenbare, alle funnet i testen:

1. **`text=` treffer delstreng.** `text=1002` fant «TEST-1002», og ville like gjerne funnet
   «10021» og «21002». Koden filtrerer derfor på **eksakt lik** `consignor-reference`. Uten
   det ville en kunde fått en annen kundes fraktetikett. Ligger som test.
2. **Søk på sporingsnummer eller sendingsnummer gir ingen treff.** Bare avsenders referanse.
3. **Avsender-ID per butikk**: Garnkilden 25848, Strikkefryd 25849 (Oslo 25846). En sending
   må slås opp med ID-en til butikken som laget den. Lagret i `stores.shipping_sender_id`.
4. **Etiketten er gyldig før overføring** til transportør, så butikken kan hente den med
   en gang – de trenger ikke vente på at sendingen er sendt til Bring.

Id-en lagres i `routing_groups.cargonizer_consignment_id` første gang, så vi søker bare én
gang per ordre. `<id>` finnes ikke i Cargonizers dokumentasjon; den er lest ut av et ekte svar.

**Nøkkelen forlater aldri serveren.** Cargonizers dokumentasjon sier PDF-URL-ene «is only
accessible trough an API call. It can not be referenced directly», så panelet kunne uansett
ikke lenket dit. `shipping-label` sjekker at brukeren hører til butikken gruppen er tildelt –
uten den sjekken kunne én butikk lastet ned en annen butikks etiketter, med deres kunders
navn og adresse.

### Bekreftet mot ekte API 30.09

`CARGONIZER_KEY` er satt. Testet med nøkkel mot sending 76295361 (avsender 25846):

| Kall | Resultat |
|---|---|
| `finnConsignment("TEST-1002", 25846)` | id 76295361, state `open` |
| `hentEtikett(76295361, 25846)` | 47 253 byte, signatur `%PDF-` |
| `finnConsignment("#1002", 25846)` | `null` – delstreng avvist mot ekte data |
| `finnConsignment("TEST-1002", 25849)` | `null` – avsender-ID-en skiller butikkene |
| `hentEtikett(76295361, 25849)` | 404 – **Cargonizer håndhever avsender også på PDF-en** |

Den siste er verdt å merke seg: selv om koden vår skulle fått tak i feil sendings-id, kan
feil avsender ikke hente etiketten. Skillet ligger i Cargonizer, ikke bare hos oss.

**Svaret har flere `<id>`-elementer.** Sendingen har sin egen, og hver `<bundle>` har sin
(76295361 mot 82387924 i testen). Sendingens ligger som direkte barn av `<consignment>`.
Derfor parses XML-en ordentlig – en regex over svaret ville plukket buntens id og hentet
feil etikett.

`api.cargonizer.no` og `cargonizer.no` gir identisk svar; koden bruker det dokumenterte.

### Ikke bekreftet ennå

- **Hva CargonizerConnect skriver i avsenders referanse.** Woo-versjonen bruker ordrenummeret.
  Koden godtar både «#1002» og «1002», men begge som eksakt treff. Må sjekkes på første ekte
  ordre gjennom appen.
- Standard datovindu for `consignments.xml` uten `from` er ikke dokumentert. Vi sender derfor
  alltid `from`, 60 dager før ordren.

## Avslagsveien testet (30.09.2026)

Testen 29.09 dekket bare godta → sendt → slått ut i kassa. Avslag var sist kjørt 09.09, altså
før flyttingen til ny Shopify-butikk og før alt som er endret siden. Avslag rører ikke
Shopify, så den lot seg teste mot basen alene.

Kjørt med en testordre (2 × Finull 401, som begge butikkene fører):

| Steg | Resultat |
|---|---|
| Garnkilden avslår | tilbudet går til Strikkefryd 0,2 s etter, ny frist og eget token |
| Strikkefryd avslår | gruppen og ordren settes `escalated`, «Ingen kvalifiserte butikker igjen i køen» |
| `timeout_streak` | uendret – aktivt avslag straffes ikke, som regelen sier |

**Rettet: butikken fikk feil beskjed.** Siste butikk som avslo fikk «går videre til neste
butikk», selv om det ikke fantes noen neste og ordren gikk til Garnly. `makeNextOffer` svarer
allerede om noen faktisk fikk tilbudet; nå brukes svaret til å velge melding. Verifisert med
begge utfallene.

**Åpent: eskaleringsvarselet når ingen.** `escalateGroup` kaller `notifyOps`, som uten
`RESEND_API_KEY` bare skriver til loggen. Det er her systemet med vilje gir fra seg ordren til
et menneske, og akkurat den overleveringen er brutt. Ordren blir liggende ON_HOLD i Shopify
til noen ser den i dashbordet, som viser eskalerte ordrer.

## Testordrer holdes utenfor oppgjøret (30.09.2026)

`routing_orders.is_test` settes i `order-intake` fra Shopify-taggen «TEST» eller Shopifys eget
`test`-flagg (testbetaling gjennom Bogus Gateway). Testordrer rutes og pakkes som ekte ordrer
– det er poenget med å teste – men holdes utenfor `v_store_settlement` og alle tellerne i
`v_panel_stats`. Kortene vises fortsatt i panelet, så butikken pakker og bekrefter
kassauttrekk som vanlig.

To signaler, fordi taggen krever at noen husker den og `test`-flagget bare settes ved
testbetaling. Regelen ligger ren i `_shared/testorder.ts`.

**Taggen matches på hele tagen, ikke delstreng.** «testgarn» og «Bestilt til testing» er
produktinformasjon; matchet vi på delstreng, ville ekte salg falt ut av oppgjøret.

#1002 (29.09) er merket. Den er sendt og kan ikke kanselleres i Shopify uten å avbryte
distribusjonen, og lageret er allerede riktig på 55 – den skal altså ikke refunderes.
Strikkefryds oppgjør gikk fra 255 kr til 0. Verifisert ved å slå flagget av og på: med
`is_test = false` kommer raden tilbake med 255 kr, så det er ekskluderingen som virker og ikke
et brudd i viewet.

#1001 og #1003 er kansellert i Shopify (22:22:37Z og 22:23:23Z), og `orders/cancelled`-webhooken
lukket gruppene. Alle tre har taggen «TEST» i Shopify.

## Lagerdrift mot Shopify lukket (29.09.2026, kveld)

Testen av hele flyten avdekket at **`sync-store` sammenlignet mot sin egen forrige utregning,
ikke mot Shopify**. Endrer Shopify `on_hand` selv – fulfillment, retur med restock, manuell
retting i admin – og vårt nye tall havner tilfeldigvis likt med det forrige, skrives
ingenting og Shopify blir stående feil. Uten en eneste feilmelding.

Reprodusert: #1002 (Alpakka Ull 6081, Strikkefryd) ble sendt og slått ut i kassa mellom to
synker uten at kassetallet endret seg. Synken regnet 55 = forrige 55 og hoppet over. Shopify
ble stående på 52.

To lag, fordi de fanger ulike ting:

1. **`v_pos_recent_transitions`** – produkter i grupper som ble sendt eller slått ut i kassa
   siste døgn skrives alltid, uavhengig av diff. Dekker tilstandsskiftene vi selv kjenner til.
2. **`reconcile-inventory`** – nattlig kl. 02:20 UTC. Leser `on_hand` per location fra Shopify
   og retter alle avvik mot `inventory.qty`. Dekker resten: returer med restock og manuelle
   endringer i admin. Stopper og varsler ved over 1000 avvik, for da er noe grunnleggende galt.

Begge verifisert ved å innføre drift med vilje (satte Shopify til 48 mot basens 55):
avstemmingen rapporterte `deviations: 1` og rettet til 55; `sync-store` rettet den samme
driften med `rows_changed: 0`, altså uten at diffen så noe.

### Gruppestatus `fulfilled`

En sendt gruppe sto igjen som `assigned` og lå i panelets pakkeliste for alltid. Ny status
`fulfilled` settes sammen med `fulfilled_at`. **Alle views som filtrerte på `assigned` måtte
med:** `v_pos_pending_deduction`, `v_panel_assigned`, `v_panel_stats` og `v_store_settlement`.
Glemt ett av dem ville enten kassauttrekket eller oppgjøret forsvunnet stille. Det samme
gjaldt `refreshOrderStatus`, purringen i `timeout-sweeper` og `order-cancelled`.

Panelet viser sendte ordrer med merket «Sendt» til kassauttrekket er bekreftet, og slipper
dem så. `v_panel_stats` har ny teller `awaiting_pos`.

### Tidlig kassauttrekk

Trykker butikken «Slått ut i kassa» FØR sendingen er opprettet, har kassa trukket fra mens
Shopify fortsatt holder varene som `committed`. `v_pos_pending_deduction` legger nå antallet
tilbake i det tilfellet, så vi ikke trekker dobbelt. Det er ikke et sjeldent tilfelle:
butikken slår ofte ut i kassa når de plukker.

### Arkivert

Grupper fra den gamle Shopify-butikken har status `archived`. To av dem sto som `assigned` og
talte med i oppgjøret som ordrer uten beløp – Strikkefryd viste 3 ordrer der bare 1 var ekte.
Nå 1 ordre, 255 kr.

### Testordrene #1001–#1003 er IKKE kansellert

Shopify melder `cancelledAt: null` på alle tre. `orders/cancelled`-webhooken har derfor ikke
feilet; det kom ingenting å levere. #1001 og #1003 ligger fortsatt ON_HOLD med åpne tilbud til
Garnkilden, og `timeout-sweeper` vil la dem gå videre når fristen ryker. #1002 er FULFILLED og
teller i oppgjøret.

## Fulfillment eies av CargonizerConnect (29.09.2026)

**Backenden fulfiller ikke lenger.** Frakt går via CargonizerConnect (Logistra) i Shopify:
butikken lager sendingen der, og appen fulfiller ordren med sporingsnummer.
`SHIPPING_PROVIDER` skal bli stående på `none`, og `createFulfillment` kalles ikke lenger fra
`offer-respond` (funksjonen står igjen i `shopify.ts`, merket ubrukt).

Det river ut grunnlaget for `fulfilled_at` slik det ble satt 29.09 tidligere på dagen. Uten
et nytt grunnlag blir feltet aldri satt, kassauttrekket fra 013 slår aldri inn – og i det
CargonizerConnect fulfiller, faller `committed` bort i Shopify og hullet er tilbake.

Nytt grunnlag, med Shopify som fasit:

- **Webhook `fulfillments/create`** → `fulfillment-webhook`. Registrert på API 2026-07.
- **Backstop i `timeout-sweeper`**: grupper som er tildelt, usendt og eldre enn en time
  spørres mot Shopify, høyst hvert kvarter per gruppe (`fulfillment_checked_at`), maks 20
  per sveip. Overlever en tapt webhook.
- Begge går gjennom `reconcileFulfilledAt` i `_shared/fulfillment_sync.ts`, så det er én
  kodevei og ikke to.

**Vi leser ikke tallene ut av webhook-payloaden.** Den bruker REST-id-er for *ordrelinjer*,
mens `routing_groups.line_items[].line_item_id` er id-en til en *fulfillment order-linje*.
De to lar seg ikke sammenligne. Webhooken brukes derfor bare som varsel, og så spør vi
Shopify. Vi leser på ordrenivå og ikke på fulfillment order: en FO kan bli splittet eller
slått sammen underveis, og da peker vår lagrede id på noe som ikke finnes lenger.

Matchingen fra sending til gruppe ligger ren i `_shared/fulfillment.ts`: location først (hver
butikk har sin egen), varianter som skille når to grupper ligger hos samme butikk. Finner den
ingenting å gå etter, står gruppen umerket – en feilmerket gruppe ville holdt igjen lager for
varer som ikke er sendt. Backstoppen prøver igjen.

### Studio Ull AS (Oslo)

`gid://shopify/Location/94717182012` er Halvors Cargonizer-avsender, ikke en butikk, og står
med 0 på lager. Den påvirker ikke rutingen: `order-intake` ruter på vårt eget lager, der
locationen ikke finnes, og `offer-respond` flytter alltid fulfillment orderen til butikkens
egen location ved aksept. `order-intake` logger nå hvilken location Shopify tildelte, så vi
ser om den blir valgt ofte. **Anbefalt:** slå av «fulfill online orders» på den i Shopify, så
den aldri kan bli valgt i det hele tatt.

### Ryddet

De 23 inaktive «Yarn kit»-radene fra den gamle butikken er slettet (migrasjon 014). Ingenting
pekte på dem. 5203 produkter igjen, 2546 synkes, 23 ekskluderte garnpakker.

### Ikke verifisert ende-til-ende

Den nye butikken har **null ordrer**, og appen mangler `write_draft_orders`, så testordren
lot seg ikke lage. Verifisert så langt: webhooken er registrert, endepunktet avviser ugyldig
signatur (401), sveipet kjører begge nye veier uten feil, og matchingen har syv tester.
Selve kjeden fulfillment → webhook → `fulfilled_at` → `on_hand` gjenstår.

## Dobbelttelling av lager lukket (29.09.2026)

Garnly-salg trekkes ikke automatisk i butikkens kasse. Butikken slår dem ut manuelt, av og
til dager etter at ordren er sendt. Shopifys `committed` dekker bare tiden **før**
fulfillment: i det fulfillment opprettes trekker Shopify selv ned `on_hand`, og neste synk
skriver kassetallet rett over igjen. Varen blir salgbar to ganger.

- `routing_groups.fulfilled_at` settes når `createFulfillment` faktisk har gått gjennom.
- `routing_groups.pos_deducted_at` settes av butikken via knappen «Slått ut i kassa» i
  panelet, som går gjennom RPC-en `mark_pos_deducted` (security definer, avgrenset av
  `current_store_ids()` – panelet har ingen skriverett på tabellen).
- `v_pos_pending_deduction` summerer linjene som er sendt, men ikke bekreftet uttrekt.
- `sync-store` trekker dem fra: `sellableQty(kassetall, safety_stock, ventende)`.
  Summen inngår i `qty`, så diffen fanger endringer i ventende uttrekk selv når kassetallet
  står stille.
- `timeout-sweeper` purrer én gang per ordre etter 24 t (`pos_reminder_sent_at`).

**Bare fulfillede linjer trekkes fra.** En tildelt, men usendt ordre står fortsatt som
`committed` i Shopify og trekkes fra `available` der. Trakk vi den fra her også, ville vi
trukket dobbelt og vist for lite på lager.

**Vi skriver fortsatt `on_hand`, ikke `available`.** Det opprinnelige forslaget var å skrive
`available` og trekke fra alle åpne linjer. Det går opp regnestykket, men bare så lenge hver
eneste `committed` i Shopify svarer til en Garnly-linje vi følger med på. En ordre som aldri
kom gjennom `order-intake`, en manuelt opprettet ordre, en umatchet varelinje – hver av dem
ville blåst opp `on_hand` permanent, stille. `on_hand` er det kassa faktisk måler, og
Shopify regner `available` selv.

Verifisert mot ekte data 29.09: Peer Gynt 1012 Natur hos Garnkilden, kassetall 21, ordre på
10 fulfillet uten bekreftet uttrekk → `on_hand` 11. Bekreftet uttrekk → `on_hand` 21 igjen,
med `rows_changed: 1` selv om kassetallet aldri endret seg. RPC-en avviser kall uten
butikktilgang.

**Retningen på feilen er valgt:** glemt knapp gir for lite på lager, aldri oversalg.

## Synkefrekvens ryddet (27.09.2026)

**Produktsynken kjørte ikke automatisk.** `sync-products` har alltid vært manuell – filhodet
sa «eller daglig via cron», men jobben fantes ikke. Cron hadde bare `sync-stores`,
`timeout-sweeper`, `pos-catalog` og opprydding. Et nytt garn lagt inn i Shopify fikk dermed
ingen rad i `products`, kassalinjene for varen havnet i `unmatched_items`, og det ble aldri
skrevet lager: varen så utsolgt ut selv med fulle hyller. Migrasjon 012 legger den inn
kl. 03:40 UTC, etter `pos-catalog`.

**Lagersynken gikk hvert 20. minutt, ikke hvert 15.** To ting, begge i `_shared/schedule.ts`:

1. `last_sync_at` ble satt på nytt når synken var *ferdig*. Avstanden til neste synk ble
   dermed 15 min pluss kjøretiden. Garnkilden (~45 s) traff 15 min, Strikkefryd (~130 s)
   drev til 20. Stempelet settes nå bare ved start, som er riktig anker.
2. Stempelet settes aldri presis på cron-tikket – utsending og oppstart tar sekunder, og
   butikkene synkes sekvensielt, så butikk nummer to venter på nummer én. Uten slakk havner
   15-minutters-merket rett etter et tikk, og butikken må vente på det neste. `graceMin`
   (2 min) trekkes derfor fra terskelen.

Slakken må være større enn forsinkelsen på stempelet. Det er grunnen til at punkt 1 måtte
fikses og ikke bare kompenseres for: en kjøring på 130 s ville dratt forsinkelsen over
enhver fornuftig slakk. Begge grensene er testet i `schedule_test.ts`.

**Natt: hver time mellom 22 og 08** i stedet for hvert 15. minutt – butikkene er stengt og
kassene står stille. Vinduet er i lokal tid (Europe/Oslo), ikke UTC, så sommertid følger med;
pg_cron kjører i UTC og kan ikke uttrykke det, derfor ligger avgjørelsen i koden.
`NIGHT_SYNC_INTERVAL_MIN=0` slår av nattsynken helt.

Verifisert i drift: Garnkilden gikk fra 20,1 til 15,0 min rett etter deploy, og nattgatingen
er kjørt ende-til-ende (svarte `{"started":0,"skipped":"natt"}` med vinduet satt til hele
døgnet, deretter tilbakestilt).

## Flyttet til ny Shopify-butikk (27.09.2026)

Garnly byttet Shopify-butikk: **`kycbgs-yy` → `fhxr10-gu.myshopify.com`**.
Produktene fikk nye id-er, og lokasjonene er nye:

| Location | GID |
|---|---|
| Strikkefryd (Mjøndalen) | `gid://shopify/Location/94717476924` |
| Garnkilden (Stavanger) | `gid://shopify/Location/94717509692` |

Backenden er flyttet over og verifisert ende-til-ende:

- **Secrets** byttet til den nye appen (client credentials-grant, som før).
  `SHOPIFY_WEBHOOK_SECRET` satt til appens client secret.
  `SHOPIFY_ADMIN_TOKEN` står tom – ellers ville den overstyrt grant-en.
- **Webhooks** opprettet på nytt på API 2026-07:
  ORDERS_PAID → `order-intake`, ORDERS_CANCELLED → `order-cancelled`.
  Den nye butikken hadde null webhooks før dette.
- **Alle 8 Edge Functions** deployet på nytt.
- **`sync-products`** kjørt: 5195 varianter speilet (3391 med EAN),
  `tracking_enabled: 0`, `garnpakker_unntatt: 23`. 2546 produkter synkes.
- **Lager skrevet** med `backfill-store-inventory` for begge butikker
  (Strikkefryd 1741 varer, Garnkilden 1150) + metafelt `garnly.stock_by_store`.

### Garnpakker unntas nå på Shopify-data, ikke på navn

Unntaket fra 003 traff `brand = 'Garnly' and name like 'Yarn kit%'`. Etter
flyttingen heter pakkene «Garnpakke – …» med nye id-er, så det unntaket sluttet
stilltiende å virke. `sync-products` kjenner dem nå igjen på `productType` eller
tag `garnpakke` i Shopify, og setter `exclude_from_sync` selv. Det overlever
neste flytting. Gavekort hoppes over i `order-intake` på
`variant.product.isGiftCard`; en ordre med bare gavekort settes ikke på hold.

### Fellen som var lett å gå i

Etter flyttingen sto Shopify på 0 i lager overalt, mens `inventory` i basen
allerede hadde riktige tall. `sync-store` skriver bare **differanser**, så den så
ingen endring og ville aldri rørt Shopify – butikken ville stått tom for alltid
uten en eneste feilmelding. Derfor engangs-backfill. Samme grunn til at
`sync_runs` så friske ut på gamle credentials: `rows_changed` var 0, så Shopify
ble aldri kontaktet. Verifisert ved å sette ett lagertall feil med vilje og se
synken skrive riktig tall tilbake til Shopify.

### Åpent

- **`RESEND_API_KEY` er tom.** Ingen driftsvarsler sendes – heller ikke varselet
  etter tre feilede synker på rad. Går synken ned, er det ingen som får beskjed.
- Den nye butikken har fortsatt en tredje location, «Shop location», som
  fullfører nettordrer. Den står på 0 i alt, så den tar ikke salg, men den bør
  ryddes vekk når flyttingen er satt.
- Garnpakkene er merket `dummy-content` i Shopify.

## Nå (09.09.2026, kveld)

**Backenden kjører.** Cron hvert 5. minutt, 242 vellykkede synkkjøringer.
Butikkpanelet, alias-matchingen og Duell-synken er slått sammen med det som
allerede sto i drift, og migrasjonene 003–008 er kjørt.

| Butikk | Kassesystem | Rader lest | Matchet | Med lager | Status |
|---|---|---|---|---|---|
| Strikkefryd | Mystore | 5262 | 1845 | 1742 varianter i Shopify | live siden 05.09 |
| Garnkilden | Duell | 6010 | 1341 | 1167 varer, 15 437 enheter | **live 09.09** |

### Garnkilden virker nå

Tre ting sto i veien, alle løst:

1. **WAF.** `api.kasseservice.no` blokkerer datasenter-IP-er. Kallene rutes nå
   gjennom en tinyproxy på en Oracle Always Free-maskin (79.76.60.202).
   `DUELL_PROXY_URL` i function-secrets. Gratis, fast IP, dekker alle
   Duell-butikker – ikke én proxy per butikk.

   **Duell bekreftet hvitelisting av 79.76.60.202 den 10.09.2026.** Den IP-en er
   dermed en del av avtalen, ikke bare et teknisk valg. Byttes proxyen ut, eller
   får maskinen ny IP, stopper Garnkilden-synken til Duell har hvitelistet den nye
   adressen. Si fra til dem før en eventuell flytting, ikke etter.
2. **Sideblading.** Duell kapper sider til 100 rader uansett hva `length` sier.
   Adapteren flyttet `start` med ønsket sidestørrelse (500) og hoppet dermed over
   fire av fem rader: Garnkilden ga 700 av 3345 rader. Retter man dette, leses
   alle 6010.
3. **Manglende strekkode.** `all/product/stock` gir verken strekkode eller navn,
   bare `product_id` og antall – derfor matchet 0 av 700. Strekkoden ligger i
   `product/list` (6010 produkter, 5098 med strekkode). Den er klient-omfattende
   og tar ~2 minutter å bla gjennom, så den mellomlagres i tabellen `pos_catalog`
   og friskes opp daglig av den nye `pos-catalog`-funksjonen. Lager og katalog
   kobles på `product_id`; `product_number` er ikke unikt og duger ikke som nøkkel.

De 2357 garnvarene som fortsatt ikke matcher, er garn Garnkilden fører men som
Garnly ikke har i sortimentet. Det er en sortimentsbeslutning, ikke en feil.
Knapper, pinner og oppskrifter (1900 varer) skal heller ikke matche.

### Garnkilden er live (09.09, kveld)

Embrik ga klarsignal. `stores.active` satt til true, og lageret skrevet med
`deno task backfill-store garnkilden`, ikke med cron-synken: første synk må
aktivere og slå på lagersporing på over tusen varianter, og det får ikke plass i
Edge Function-budsjettet.

| Steg | Resultat |
|---|---|
| Aktivert på location | 1124 nye, 1167 totalt |
| Antall skrevet | 1167 varer |
| Metafelt `stock_by_store` | 1167 varianter |

Verifisert direkte mot Shopify: Merinoull 1001 optisk hvit viser 37 hos
Garnkilden og 36 hos Strikkefryd, både som inventory level og i metafeltet.
Videre endringer tas av cron-synken hvert 5. minutt.

**Feil funnet og rettet underveis.** Backfill-skriptet skrev `stock_by_store`
med bare butikkens egen location. For de 931 varene begge butikker fører, ville
Strikkefryds antall blitt slettet fra metafeltet, og kassevalideringen ville
trodd Garnkilden var alene om varen. Cron-synken ville ikke rettet det, siden den
bare skriver metafelt for varer der antallet endrer seg. Skriptet henter nå
tallene på tvers av butikkene.

Strikkefryd gikk samtidig fra 1565 til 1845 matchede rader, etter alias-seeden og
de 1513 nye variantene fra 05.09.

### Butikkpanelet er live

**https://garnly-butikkpanel.vercel.app**

Embrik vil ikke ha e-post til butikkene, bare panelet. `notify_offers` står derfor
på false på begge butikker, og verken Resend- eller Twilio-nøkkel er satt. Panelet
er eneste kanal.

Vercel med rot `panel/`, samme sted som dashboardet. Cloudflare Pages ble droppet
(krever innlogging vi ikke har), og Supabase Storage duger ikke fordi den serverer
HTML som `text/plain` av sikkerhetsgrunner. En midlertidig `panel`-funksjon holdt
det gående til Vercel var oppe, og er slettet nå: to kopier kan komme i utakt.

Verifisert mot Vercel-adressen: begge butikker logger inn med anon-nøkkelen som
faktisk serveres derfra, RLS gir hver av dem kun egne rader, panel-viewene svarer
200, og `offer-respond` returnerer nøyaktig dette origin i CORS-headeren.
`v_panel_queue` eksponerer ikke `raw_order` – kun postnummer og sted av kundedata.

Innloggingene ligger utenfor repoet. Passordene bør byttes av butikkene selv.

### Testordre kjørt ende til ende (09.09, 13:30)

Ordre #1001 og #1002 lagt inn som utkastordre markert betalt. Gratis, krever ingen
betalingsleverandør, og utløser `orders/paid` som rutingen lytter på. Rutingsappen
har bevisst ikke rett til å opprette ordrer, så de ble lagt inn via Shopify-koblingen.

Verifisert: webhook mottatt, ordre satt på hold, gruppe planlagt, tilbud sendt til
Strikkefryd med riktig frist (3 timer, innenfor åpningstid), avslag går videre og
eskalerer når ingen andre har varen, aktivt avslag gir ikke nedvekting
(`timeout_streak` = 0), aksept flytter fulfillment order og slipper holdet, og
kansellering i Shopify rydder opp i basen.

Fire feil funnet og rettet underveis, alle slike som bare vises i drift:

1. **`hidden` virket ikke på innloggingsskjermen.** `.login` setter `display:grid`,
   som slår nettleserens eget stilsett. Innloggingen ble liggende over panelet etter
   vellykket innlogging, så det så ut som ingenting skjedde. Panelet var ubrukelig.
2. **Panelet svelget klikkene.** `refresh()` byttet ut hele køen med `innerHTML`
   hvert kall, også uten endring. Traff det mellom museknapp ned og opp, forsvant
   klikket sporløst. Skjedde hele tiden fordi `start()` ble kalt på nytt ved hver
   auth-hendelse og hopet opp `visibilitychange`-lyttere.
3. **Sanntidssjekken av lager hentet hele katalogen.** `fetchStockFor` kan ikke
   spørre om enkeltvarer i noen adapter: 5262 rader for Strikkefryd i sider på 50
   med 550 ms pause, over ett minutt. Godta tidde ut. Sjekken har nå 8 sekunders
   frist og godtar ellers på synket lager (maks 15 min gammelt), med logg i audit.
4. **`fulfillmentOrderMove` krasjet aksepten.** Shopify hadde allerede tildelt
   ordren til Strikkefryds location, og avviser flytting til samme sted:
   «Cannot move to the current origin location». Nå sjekkes gjeldende location
   først, og feilen tåles om to butikker svarer tett i tid.

### Gjenstår på sanntidssjekken

Den hopper i praksis over hver gang, fordi ingen av adapterne kan slå opp enkelte
strekkoder. Mystore gjenkjenner `filter[ean][path]`/`[value]`, men avviste
operatorene som ble prøvd (`eq`, `equals`, `like`, `in`, `contains`) før
ratebegrensningen slo inn; `=` og `==` rakk ikke å bli testet. Duell har ingen
verifisert vei. Får man dette på plass, blir Godta også raskt: aksepten bruker nå
11 sekunder, hvorav 8 er fristen som løper ut.

### Feil funnet ved verifisering: 254 varer var usynlige i butikken

Strikkefryd hadde 1742 varer med lager i basen, men bare 1488 aktivert i Shopify.
Arwetta Classic 955 sto med 12 på lager hos oss, mens varen i Shopify bare fantes
på «Shop location» med 0. Kunder så den som utsolgt. Hele Arwetta-serien var rammet.

Årsaken er rekkefølgen i `sync-store`: antallet skrives til `inventory` før
Shopify-skrivingen. Dør kjøringen mellom de to, har basen riktig tall, neste
kjøring ser ingen endring, og varen får aldri noe inventory level på locationen.
Det skjedde 21 ganger fra 06.09 og utover, og reparerte seg aldri selv.

Rettet to steder:
- `sync-store` driver nå Shopify-arbeidet av endrede varer **pluss** varer med
  lager som mangler aktivering. Neste synk henter dermed inn det som er strandet.
- De 254 ble hentet inn med `deno task backfill-store strikkefryd` (258 aktivert).

Begge butikker står nå på null varer som mangler aktivering.

De hengende `sync_runs`-radene er fortsatt et lite problem i seg selv:
bakgrunnsjobben (`EdgeRuntime.waitUntil`) blir av og til gjenvunnet før den er
ferdig, så statusen blir stående på `running`. Lageret blir riktig nå uansett,
men radene bør merkes som avbrutt etter en tidsfrist.

---

## Deployet 04.09.2026
- Supabase `zesaeleooiptrpjzqhxe`: skjema (001) + cron (002) kjørt, 3 cron-jobber aktive.
  `functions_url`/`cron_secret` ligger i **Vault** (ALTER DATABASE ... SET er ikke tillatt på Supabase).
- Alle 7 Edge Functions deployet, 21 secrets satt. `timeout-sweeper` testet OK ende-til-ende.
- Shopify-app «Garnly ruting» på nye Dev Dashboard-plattformen (client credentials-grant, ikke fast
  token). Client ID/secret i function-secrets; backenden fornyer token selv. Webhook-API 2026-07,
  Admin API satt til 2026-07.
- Webhooks opprettet via API: ORDERS_PAID → order-intake, ORDERS_CANCELLED → order-cancelled.
- Locations finnes allerede i Shopify: «Strikkefryd (Mjøndalen)» (gid .../125074604318),
  «Garnkilden (Stavanger)» (gid .../125074637086) + Shop location.
- Dashboard live på Vercel (garnly-garnbutikk.vercel.app, HTTP Basic).
## Strikkefryd LIVE 05.09.2026
- Strikkefryd (Mystore, shop=strikkefryd) lagt inn i stores/store_secrets. Location
  «Strikkefryd (Mjøndalen)» gid .../125074604318. Kontakt = embriks e-post i pilot.
- sync-products: 3690 varianter speilet (1721 med EAN). Bare garn synkes – 23 «Yarn kit»
  ekskludert (exclude_from_sync, migrasjon 003).
- Mystore-adapter rettet mot ekte felt (name-objekt, ikke products_name; status/disabled filtreres).
- **Lager skrevet til Shopify**: 1488 garnvarianter med lager aktivert + lagersporing på +
  antall satt på Strikkefryd-location, og metafelt garnly.stock_by_store satt. Verifisert i Shopify
  (Peer Gynt 1042 = 59 stk osv.). 5262 rader lest, 1565 matchet, resten (oppskrifter/gavekort/ikke-ført) i unmatched_items.
- Videre lagerendringer håndteres av cron hvert 15. min.

## Gjort 02.09.2026 (Cowork)
- Strikkefryd (Mystore) API testet live: 2131 produkter, 4918 varianter, ~88 % med EAN, 3530 varianter med lager.
- Strikkefryds katalog matchet mot Garnly2 på garnlinje + fargekode: **1381 EAN-er skrevet inn som `barcode` på Garnly2-varianter** (av 3667 garnvarianter). Rapport: `docs/barcode_match_rapport.csv`.
- Resten uten strekkode er i hovedsak linjer Strikkefryd ikke fører (Hillesvåg, Isager, deler av Dale/Rauma) → EAN hentes fra Duell-butikken eller produsentlister senere.
- Strikkefryd-token skal inn i `store_secrets` ved deploy; be butikken lage ny token når integrasjonen er i drift (denne har vært delt i chat).
- Fortsatt i Shopify: lager ikke sporet på variantene (settes av inventoryActivate ved første synk), ingen SKU, én location, ingen webhooks.

## Gjort 03.09.2026 (Cowork)
- Duell-butikken er **Garnkilden AS** (Stavanger). API verifisert fra Embriks maskin: login, `department/list` (api_token for avdeling 1), `product/list` (6 001 produkter, 3 107 garn, 85 % med EAN) og `all/product/stock`.
- Duell-adapteren skrevet om etter ekte API: strekkode ligger i `product/list`, lager i `all/product/stock`, maks 100 rader/side, paginer på mottatte rader. `listDepartments()` for onboarding.
- Garnkilden matchet mot Garnly2: 824 varianter identiske med Strikkefryd (bekrefter forrige runde), **340 nye EAN-er skrevet** (Finull, Vams, Pandora, Fivel, Alpaca Silk, Mitu m.fl.), 8 konflikter beholdt Strikkefryd-verdien (se `docs/barcode_match_rapport_garnkilden.csv`).
- Totalt nå: ~1 720 av 3 667 garnvarianter har strekkode. De ~1 950 uten er Filcolana (Arwetta, Peruvian, Saga, Vilja, Tilia, Anina, Pernilla, Alva-rest), Hillesvåg (Ask, Troll, Luna, Huldra, Sol, Vilje, Vidde) og Ryegarn: ingen av de to butikkene fører dem.
- **WAF-advarsel:** api.kasseservice.no svarer med AWS WAF-captcha til skyservere (Cowork-containeren ble blokkert). Fra Embriks Mac gikk alt. Må testes fra Supabase Edge Functions ved deploy; fallback = be support@duell.no hvitliste, eller proxy.
- Duell-tokens er IP-bundet (`ip`-claim i JWT); hver kjøremiljø må logge inn selv (adapteren gjør det).

## Gjort 06.09.2026 (Cowork)
- Embrik/Halvor la inn **57 nye produkter / 1 348 varianter** i Shopify 05.09 (Isager, Ístex, Cardiff, Lana Grossa, Permin, Rauma, Rowan, Solberg, Viking), alle DRAFT, med EAN som både `sku` og `barcode`. Ingen EAN-kollisjoner med de 133 eldre produktene.
- Dekning mot butikkene (`docs/sortiment_dekning_2026-09-06.csv`): **1 275 varianter matcher på EAN** (Strikkefryd 435, Garnkilden 917, begge 77). 69 av de 73 uten strekkode er koblet via `product_aliases` (Cardiff Classic/Prime hos Garnkilden har bare interne koder som «18379», Strikkefryd har ingen EAN på dem). 4 finnes ikke hos noen: Classic 739 Japan Blue, Spinni «3» (ufullstendig tittel), Plötulopi 0417 Red, Tumi B137 Korallrød.
- Viktig funn: Duell leverer noen EAN-er som GTIN-14 med ledende null (`05744003423439`). `normalizeEan` håndterer det; egne analyser må gjøre det samme.
- Lokasjoner i Shopify: Strikkefryd (Mjøndalen) `gid://shopify/Location/125074604318`, Garnkilden (Stavanger) `gid://shopify/Location/125074637086`. Fortsatt ingen lagersporing på noen varianter (5 203); `sync-products` slår det på ved første kjøring.
- Sortimentsregneark (Garnly_sortiment_Strikkefryd_Garnkilden.xlsx) ligger på Embriks Mac i ~/Garnly; garnlinje-versjonen som Google Sheet i Drive «Garnly → AI → Garnly».

## Gjort 09.09.2026 (Cowork)
- **Butikkpanel bygget** (`panel/`). E-post per tilbud skalerer ikke: en butikk med 50 ordrer om dagen får 50 e-poster, og fristene begynner å gå ut. Erstattet med en side butikken har oppe på nettbrett ved pakkebordet.
  - Sanntid via Supabase Realtime på `offers`, polling hvert 30. sekund som reserve, lyd og telling i fanetittel ved ny ordre, wake lock så skjermen ikke sovner.
  - Innlogging med Supabase Auth (e-post + passord). `store_users` + RLS gir butikken kun sine egne rader. Views `v_panel_queue`, `v_panel_assigned`, `v_panel_stats` skjuler `raw_order` og resten av kundedataene.
  - Godta/avslå går til `offer-respond` med bruker-JWT. Funksjonen fikk tre inngangsveier: panel (POST + JWT), engangslenke (GET, reserve) og internt kall (auto_accept). All logikk er delt.
  - «Godta alle» for kø, nedtelling per ordre som skifter farge når det er under en time og under et halvt igjen.
- `stores.notify_offers` (default false) skrur av e-post og SMS per tilbud. `notifyOps` til Garnly står igjen, det er intern varsling og ikke butikkspam.
- Shopify: to butikklokasjoner manglet i fraktprofilen, derfor viste hele butikken utsolgt selv med lager inne. Lagt inn, testet handlekurv og fraktrater. Garnpakkene fikk lagersporing av, siden de settes sammen av garn butikken allerede har.

## Kjente forbedringspunkter (ikke-blokkerende)
- Første synk av en ny butikk gjøres med `deno task backfill-store <slug>` (tung aktivering
  tåler ikke Edge Function-tidsbudsjettet). sync-store bør senere gjøres chunk-gjenopptakbar
  så onboarding skjer uten manuelt steg. Backfill er gjenopptakbar og idempotent.
- Migrasjoner kjøres mot prosjektet via Management API (001–008). Vault holder functions_url/cron_secret.
- Migrasjonsnumrene 003 og 004 fantes i to versjoner. De som er kjørt i produksjon beholdt
  numrene (`003_exclude_from_sync`, `004_inventory_activated`); panel og alias ble flyttet til
  007 og 008.

## Blokkerende avklaringer
1. Frakt: Shipmondo vs Cargonizer (Logistra) – fortsatt åpent.
2. EAN for Filcolana/Hillesvåg/Ryegarn: tredje butikk eller produsentlister.
3. Frakt for Garnkilden: samme åpne valg som for Strikkefryd.

## Ikke deployet ennå (krever tilganger)
- **butikk.garnly.no**: valgfritt. Legg domenet til i Vercel-prosjektet, sett CNAME,
  og oppdater `PANEL_ORIGIN`. Panelet virker uten det.
- **Produksjonsgren i Vercel**: prosjektet ble importert fra `claude/filene-osm-lkrd5t`.
  Sett den til `main` under Settings → Git etter merge, ellers slutter panelet å oppdatere seg.
- **Validation Function**: `shopify app deploy` fra `shopify-app/` (krever Shopify CLI-innlogging),
  deretter aktiveres valideringen i Shopify admin → Settings → Checkout.
- **Ikon** `panel/icon.png` (512×512) for hjemskjerm på nettbrett.

## Ikke bygget ennå
- Partnerside med innlogging (fase 2)

---

