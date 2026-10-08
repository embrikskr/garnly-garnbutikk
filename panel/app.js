/**
 * Garnly butikkpanel.
 *
 * Henger på Supabase direkte for lesing (RLS sørger for at butikken bare ser sine
 * egne rader), og kaller Edge Function offer-respond for godta og avslå, slik at
 * lagersjekk, Shopify-flytting og fraktbooking alltid skjer på serveren.
 *
 * Sanntid: postgres_changes på offers. Polling hvert 30. sekund som reserve, i
 * tilfelle nettbrettet har sovet eller WebSocket-en har falt ut.
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CFG = window.GARNLY_CONFIG;
const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const $ = (id) => document.getElementById(id);
const el = {
  login: $("login"), loginForm: $("login-form"), loginError: $("login-error"),
  app: $("app"), storeName: $("store-name"), storeSwitch: $("store-switch"),
  queue: $("queue"), queueEmpty: $("queue-empty"),
  assigned: $("assigned"), assignedEmpty: $("assigned-empty"),
  acceptAll: $("accept-all"), logout: $("logout"), toast: $("toast"),
  conn: $("conn"), soundToggle: $("sound-toggle"),
  faneAktive: $("fane-aktive"), faneHistorikk: $("fane-historikk"),
  visningAktive: $("visning-aktive"), visningHistorikk: $("visning-historikk"),
  historikk: $("historikk"), historikkEmpty: $("historikk-empty"), historikkPeriode: $("historikk-periode"),
  sok: $("sok"), visFlere: $("vis-flere"),
  detalj: $("ordre-detalj"), detaljInnhold: $("detalj-innhold"), detaljLukk: $("detalj-lukk"),
  innstillinger: $("innstillinger"), innstillingerDialog: $("innstillinger-dialog"),
  innstillingerLukk: $("innstillinger-lukk"), innstillingerLagre: $("innstillinger-lagre"),
  autoGodkjenn: $("auto-godkjenn"),
  faneGarnly: $("fane-garnly"), visningGarnly: $("visning-garnly"),
  adminTall: $("admin-tall"), adminHandling: $("admin-handling"), adminHandlingTom: $("admin-handling-tom"),
  adminSynk: $("admin-synk"), adminOrdrer: $("admin-ordrer"), adminOrdrerTom: $("admin-ordrer-tom"),
  filterButikk: $("filter-butikk"), filterStatus: $("filter-status"), filterTest: $("filter-test"),
  giDialog: $("gi-dialog"), giOrdre: $("gi-ordre"), giButikk: $("gi-butikk"),
  giSend: $("gi-send"), giLukk: $("gi-lukk"),
};

/** Historikk: standardvindu, og hvor mye «Vis flere» utvider med. */
const HISTORIKK_DAGER = 30;
const HISTORIKK_SIDE = 25;

let stores = [];
let storeId = null;
let channel = null;
let pollTimer = null;
let tickTimer = null;
let knownOfferIds = new Set();
let firstLoad = true;
let soundOn = localStorage.getItem("garnly.sound") !== "off";
let busy = new Set();
let started = false;
let queueSig = null;
let assignedSig = null;
let historikkDager = HISTORIKK_DAGER;
let historikkGrense = HISTORIKK_SIDE;
let historikkRader = [];
let sokTimer = null;
let autoGodkjenning = false;
let erAdmin = false;
let alleButikker = [];
let adminTimer = null;
// Brukeren hvis data står på skjermen. Se start().
let visningFor = null;

// ---------------------------------------------------------------- oppstart

// Auth-hendelser kommer flere ganger (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED),
// og getSession() under svarer i tillegg. start() må derfor tåle å bli kalt om igjen:
// gjorde den ikke det, hopet det seg opp en visibilitychange-lytter per kall, og køen
// ble tegnet på nytt like mange ganger ved hvert tabbytte.
sb.auth.onAuthStateChange((_event, session) => {
  if (session) start();
  else showLogin();
});

document.addEventListener("visibilitychange", () => { if (!document.hidden && started) refresh(); });

sb.auth.getSession().then(({ data }) => (data.session ? start() : showLogin()));

function showLogin() {
  teardown();
  el.app.hidden = true;
  el.login.hidden = false;
}

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = el.loginForm.querySelector("button");
  const fd = new FormData(el.loginForm);
  btn.disabled = true;
  el.loginError.hidden = true;
  primeSound();
  const { error } = await sb.auth.signInWithPassword({
    email: String(fd.get("email")).trim(),
    password: String(fd.get("password")),
  });
  btn.disabled = false;
  if (error) {
    el.loginError.textContent = "Feil e-post eller passord.";
    el.loginError.hidden = false;
  }
});

// Utlogging laster siden på nytt. Panelet holder butikknavn, tall, kort, faner og
// butikkvelger i over ti variabler og i DOM-en, og et nettbrett deles gjerne: den neste som
// logger inn skal ikke arve noe av det. Å nullstille hver bit for hånd glemmer alltid én.
el.logout.addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

el.soundToggle.addEventListener("click", () => {
  soundOn = !soundOn;
  localStorage.setItem("garnly.sound", soundOn ? "on" : "off");
  el.soundToggle.setAttribute("aria-pressed", String(soundOn));
  el.soundToggle.textContent = soundOn ? "🔔" : "🔕";
  if (soundOn) beep();
});

async function start() {
  if (started) return;
  started = true;

  // Utløpt økt viser innloggingen uten å laste siden på nytt. Logger en ANNEN bruker inn da,
  // lastes siden på nytt før noe tegnes – ellers står den forriges data igjen under.
  const { data: { session } } = await sb.auth.getSession();
  const bruker = session?.user?.id ?? null;
  if (visningFor && bruker !== visningFor) {
    location.reload();
    return;
  }
  visningFor = bruker;
  el.login.hidden = true;
  el.app.hidden = false;
  el.soundToggle.textContent = soundOn ? "🔔" : "🔕";

  // Admin ser alle butikker (egen RLS-policy), men er ikke selv en butikk. Hvilke faner som
  // vises styres derfor av medlemskapet i store_users, ikke av butikklista.
  const [alle, medlem, admin] = await Promise.all([
    sb.from("stores").select("id, name").order("name"),
    sb.from("store_users").select("store_id"),
    sb.from("garnly_admins").select("user_id").maybeSingle(),
  ]);
  erAdmin = !!admin.data;
  alleButikker = alle.data ?? [];
  const mine = new Set((medlem.data ?? []).map((r) => r.store_id));
  stores = alleButikker.filter((s) => mine.has(s.id));

  el.faneGarnly.hidden = !erAdmin;
  if (!stores.length) {
    if (!erAdmin) {
      toast("Brukeren er ikke koblet til en butikk. Ta kontakt med Garnly.", "error");
      return;
    }
    // Ren Garnly-bruker: butikkfanene har ingenting å vise. Toppen viser «Garnly admin»,
    // ikke en tilfeldig butikks navn.
    el.storeSwitch.hidden = true;
    el.storeName.textContent = "admin";
    document.title = "Garnly admin";
    el.faneAktive.hidden = true;
    el.faneHistorikk.hidden = true;
    velgFane("garnly");
    klargjorAdminfiltre();
    await lastAdmin();
    adminTimer = setInterval(lastAdmin, 60000);
    keepAwake();
    return;
  }
  if (erAdmin) klargjorAdminfiltre();

  storeId = localStorage.getItem("garnly.store") && stores.some((s) => s.id === localStorage.getItem("garnly.store"))
    ? localStorage.getItem("garnly.store")
    : stores[0].id;

  if (stores.length > 1) {
    el.storeSwitch.hidden = false;
    el.storeSwitch.innerHTML = stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    el.storeSwitch.value = storeId;
    el.storeSwitch.onchange = () => {
      storeId = el.storeSwitch.value;
      localStorage.setItem("garnly.store", storeId);
      knownOfferIds = new Set();
      firstLoad = true;
      subscribe();
      refresh();
    };
  }
  el.storeName.textContent = stores.find((s) => s.id === storeId)?.name ?? "";

  subscribe();
  await refresh();

  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, CFG.POLL_MS ?? 30000);
  clearInterval(tickTimer);
  tickTimer = setInterval(tickDeadlines, 1000);

  keepAwake();
}

function teardown() {
  started = false;
  queueSig = assignedSig = null;
  if (channel) { sb.removeChannel(channel); channel = null; }
  clearInterval(pollTimer); clearInterval(tickTimer); clearInterval(adminTimer);
}

// ---------------------------------------------------------------- sanntid

function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb
    .channel(`offers:${storeId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "offers", filter: `store_id=eq.${storeId}` }, refresh)
    .subscribe((status) => {
      const live = status === "SUBSCRIBED";
      el.conn.dataset.state = live ? "up" : "down";
      el.conn.title = live ? "Tilkoblet, oppdaterer seg selv" : "Mistet sanntid, henter hvert 30. sekund";
    });
}

// ---------------------------------------------------------------- data

async function refresh() {
  if (!storeId) return;
  // Tallene i toppen («nye / å pakke / i dag») er fjernet (Embrik 08.10.2026): fanene og
  // kolonnene viser det samme, og tre nuller i toppen var bare støy.
  const [queue, assigned] = await Promise.all([
    sb.from("v_panel_queue").select("*").eq("store_id", storeId).order("deadline_at", { ascending: true }),
    sb.from("v_panel_assigned").select("*").eq("store_id", storeId).order("assigned_at", { ascending: false }),
  ]);

  const rows = queue.data ?? [];
  const fresh = rows.filter((r) => !knownOfferIds.has(r.offer_id));
  if (!firstLoad && fresh.length) notifyNew(fresh.length);
  knownOfferIds = new Set(rows.map((r) => r.offer_id));
  firstLoad = false;

  renderQueue(rows, fresh.map((r) => r.offer_id));
  renderAssigned(assigned.data ?? []);

  document.title = rows.length ? `(${rows.length}) Garnly butikkpanel` : "Garnly butikkpanel";
  el.acceptAll.hidden = rows.length < 2;
}

// ---------------------------------------------------------------- visning

function renderQueue(rows, freshIds) {
  el.queueEmpty.hidden = rows.length > 0;
  // Bare bytt ut nodene når innholdet faktisk er endret. Skjer det midt mellom
  // museknapp ned og opp, forsvinner klikket sporløst: knappen brukeren trykket på
  // finnes ikke lenger når museknappen slippes, og click-hendelsen uteblir.
  const html = rows.map((r) => {
    const level = deadlineLevel(r.deadline_at);
    const cls = freshIds.includes(r.offer_id) ? "card card--new" : `card card--${level}`;
    return `<article class="${cls}" data-offer="${r.offer_id}" data-deadline="${r.deadline_at ?? ""}">
      <div class="card__head">
        <span class="card__order">${esc(r.order_name ?? "Ordre")}</span>
        <span class="card__meta">Svar innen <span class="card__deadline" data-level="${level}">${countdown(r.deadline_at)}</span></span>
      </div>
      <ul class="lines">${lineItems(r.line_items)}</ul>
      ${r.ship_city ? `<p class="addr">Sendes til ${esc(r.ship_zip ?? "")} ${esc(r.ship_city)}</p>` : ""}
      <div class="card__actions">
        <button class="btn btn--primary" data-act="accept">Godta</button>
        <button class="btn btn--secondary" data-act="decline">Avslå</button>
      </div>
    </article>`;
  }).join("");
  if (html === queueSig) return;
  queueSig = html;
  el.queue.innerHTML = html;
}

function renderAssigned(rows) {
  el.assignedEmpty.hidden = rows.length > 0;
  const html = rows.map((r) => {
    const sendt = !!r.fulfilled_at;
    return `
    <article class="card ${sendt ? "card--packing" : "card--klar"}${etterlyst(r) ? " card--reminder" : ""}" data-group="${r.group_id}">
      <div class="card__head">
        <span class="card__order">${esc(r.order_name ?? "Ordre")}${r.is_test ? ' <span class="merke">TEST</span>' : ""}${sendt ? ' <span class="merke">Sendt</span>' : ""}</span>
        <span class="card__meta">${r.assigned_at ? klokke(r.assigned_at) : ""}${etikettIkon()}</span>
      </div>
      <ul class="lines">${lineItems(r.line_items)}</ul>
      <p class="addr">${esc(r.ship_name ?? "")}<br>${esc(r.ship_address1 ?? "")}${r.ship_address2 ? "<br>" + esc(r.ship_address2) : ""}<br>${esc(r.ship_zip ?? "")} ${esc(r.ship_city ?? "")}</p>
      ${pakkeboks(r)}
      ${etikettStatus(r, sendt)}
      ${r.tracking_number ? `<p class="track">Sporing: ${r.tracking_url ? `<a href="${esc(r.tracking_url)}" target="_blank" rel="noopener">${esc(r.tracking_number)}</a>` : esc(r.tracking_number)}</p>` : ""}
      ${fraktStatus(r)}
      ${feilboks(r)}
      ${handlinger(r, sendt)}
      ${sendt ? kassaStatus(r) : ""}
    </article>`;
  }).join("");
  if (html === assignedSig) return;
  assignedSig = html;
  el.assigned.innerHTML = html;
}

/**
 * Knappen på kortet.
 *
 * Før sending: én knapp som gjør alt – kassauttrekk, sending i Cargonizer, fulfillment i
 * Shopify og etiketten. Butikkene har ikke tilgang til Shopify-admin, så dette er eneste vei
 * ut for ordren. Feiler den, viser kortet feilen, og ordren havner hos Garnly.
 *
 * Etter sending: ingen knapp. Etiketten ligger som ikon i korthodet.
 */
function handlinger(r, sendt) {
  if (sendt) return "";
  return `<div class="card__actions card__actions--etikett">
      <button class="btn btn--primary" data-act="send">${r.ship_error ? "Prøv igjen" : "Slått ut og klar til sending"}</button>
    </div>`;
}

/**
 * Etiketten kan skrives ut med ikonet før pakken er slått ut. Da skal kortet si det, så de
 * ikke skriver den ut to ganger – og «Slått ut og klar til sending» skriver den ikke ut igjen.
 */
function etikettStatus(r, sendt) {
  if (!r.label_printed_at || sendt) return "";
  return `<p class="etikett-ok">Etikett skrevet ut ${klokke(r.label_printed_at)}</p>`;
}

/** Feilen fra forrige forsøk, med det som faktisk ble gjort. */
function feilboks(r) {
  if (!r.ship_error) return "";
  const hvor = { uttrekk: "kassauttrekket", sending: "fraktsendingen", fulfillment: "Shopify", etikett: "etiketten" };
  return `<p class="feil" role="alert"><b>Stoppet på ${hvor[r.ship_step] ?? "et steg"}:</b> ${esc(r.ship_error)}</p>`;
}

/** Pakkeboksen sendingen går til. Butikken slipper å lure på hvor pakken havner. */
function pakkeboks(r) {
  const p = r.service_partner;
  if (!p?.name) return "";
  return `<p class="pakkeboks">Til ${esc(p.name)}${p.address1 ? ", " + esc(p.address1) : ""}${p.city ? ", " + esc(p.city) : ""}</p>`;
}

/**
 * Garnly-salg trekkes ikke automatisk i kassa. Til butikken bekrefter uttrekket, viser
 * Garnly færre på lager enn kassa sier – ellers ville vi solgt garn som alt er sendt.
 */
function kassaStatus(r) {
  if (r.pos_deducted_at) {
    return `<p class="kassa kassa--ok">Slått ut i kassa ${klokke(r.pos_deducted_at)}</p>`;
  }
  const purre = etterlyst(r);
  return `<div class="card__actions">
      <button class="btn btn--secondary" data-act="deducted">Slått ut i kassa</button>
    </div>
    ${purre ? `<p class="kassa kassa--purre">Sendt for over et døgn siden. Til dette er slått ut i kassa, holder Garnly igjen varene på lageret.</p>` : ""}`;
}

/**
 * Er sendingen meldt inn til transportøren?
 *
 * CargonizerConnect lager sendingen, men overfører den ikke. Gjør ikke Garnly det, står
 * pakken som «Usendt» hos Logistra og sporingsnummeret kunden fikk virker ikke – uten at
 * noe ser galt ut i panelet. Derfor står det her.
 */
function fraktStatus(r) {
  if (r.transferred_at) {
    return `<p class="frakt frakt--ok">Overført til ${esc(r.carrier || "transportør")} ${klokke(r.transferred_at)}</p>`;
  }
  // Sendt utenom Cargonizer: det finnes ingenting å overføre. Uten denne ville kortet sagt
  // «Ikke overført ennå» om en pakke som er sendt helt fint.
  if (r.manually_shipped_at) {
    return `<p class="frakt frakt--ok">Sendt manuelt${r.carrier ? ` med ${esc(r.carrier)}` : ""}</p>`;
  }
  if (!r.fulfilled_at) return "";
  // Overføringen skjer normalt i samme minutt som sendingen. Vi maser ikke om det første
  // kvarteret; står den igjen etterpå, skal butikken vite det før kunden ringer.
  if (Date.now() - new Date(r.fulfilled_at).getTime() < 15 * 60 * 1000) return "";
  return `<p class="frakt frakt--venter">Ikke overført til transportør ennå. Garnly prøver videre; sporingen virker ikke før den er det.</p>`;
}

/** Sendt for mer enn 24 t siden uten at uttrekket er bekreftet. */
function etterlyst(r) {
  if (r.pos_deducted_at || !r.fulfilled_at) return false;
  return Date.now() - new Date(r.fulfilled_at).getTime() > 24 * 3600 * 1000;
}

// ---------------------------------------------------------------- tidligere ordrer

/**
 * «Tidligere ordrer».
 *
 * Når butikken har slått ut ordren i kassa, forsvinner den fra pakkelista. Herfra finner de
 * den igjen: fraktetiketten, sporingen og hva som lå i pakken – det de trenger når kunden
 * ringer, pakken må sendes på nytt, eller etiketten må skrives ut igjen.
 *
 * Avslåtte ordrer står uten kundedata. Det er viewet som nuller dem, ikke denne koden.
 */
const STATUSTEKST = {
  sendt: "Sendt",
  slatt_ut: "Slått ut i kassa",
  kansellert: "Kansellert",
  avslatt: "Avslått av oss",
  til_pakking: "Til pakking",
};

async function lastHistorikk() {
  if (!storeId) return;
  const fra = new Date(Date.now() - historikkDager * 86400_000).toISOString();
  const sok = el.sok.value.trim();

  let q = sb.from("v_panel_history").select("*").eq("store_id", storeId);
  // Søk går forbi datovinduet: leter butikken etter et ordrenummer, skal de finne det
  // uansett hvor gammelt det er. Uten dette måtte de trykke «Vis flere» i blinde først.
  if (sok) {
    const m = sok.replace(/[%,()]/g, " ");
    q = q.or(`order_name.ilike.%${m}%,ship_name.ilike.%${m}%`);
  } else {
    q = q.gte("order_created_at", fra);
  }
  const { data, error } = await q.order("order_created_at", { ascending: false }).limit(historikkGrense + 1);
  if (error) {
    console.error("[historikk]", error);
    toast("Fikk ikke hentet tidligere ordrer.", "error");
    return;
  }
  const rader = data ?? [];
  // Vi ba om én ekstra for å vite om det finnes flere, men viser den ikke.
  const flere = rader.length > historikkGrense;
  historikkRader = flere ? rader.slice(0, historikkGrense) : rader;
  el.visFlere.hidden = !flere;
  el.historikkPeriode.textContent = sok ? `Søk: ${sok}` : `Siste ${historikkDager} dager`;
  renderHistorikk();
}

function renderHistorikk() {
  el.historikkEmpty.hidden = historikkRader.length > 0;
  el.historikk.innerHTML = historikkRader.map((r) => `
    <article class="hist" data-group="${r.group_id}" tabindex="0" role="button">
      <div class="hist__topp">
        <span class="hist__ordre">${esc(r.order_name ?? "Ordre")}${r.is_test ? ' <span class="merke">TEST</span>' : ""}</span>
        <span class="hist__status hist__status--${r.status}">${STATUSTEKST[r.status] ?? r.status}</span>
        ${r.refundert ? '<span class="merke merke--refundert">Refundert</span>' : ""}
        ${r.kind === "tildelt" && r.status !== "kansellert" ? etikettIkon() : ""}
      </div>
      <div class="hist__bunn">
        <span>${r.ship_name ? esc(r.ship_name) : "&mdash;"}</span>
        <span class="hist__dato">${dato(r.order_created_at)}</span>
      </div>
    </article>`).join("");
}

function apneDetalj(groupId) {
  const r = historikkRader.find((x) => x.group_id === groupId);
  if (!r) return;
  const adresse = r.ship_address1
    ? `<p class="addr">${esc(r.ship_name ?? "")}<br>${esc(r.ship_address1)}${r.ship_address2 ? "<br>" + esc(r.ship_address2) : ""}<br>${esc(r.ship_zip ?? "")} ${esc(r.ship_city ?? "")}${r.ship_country ? "<br>" + esc(r.ship_country) : ""}</p>`
    : `<p class="addr">Ordren ble avslått, så vi viser ikke kundeopplysninger.</p>`;

  const tider = [
    r.assigned_at ? ["Godtatt", tidspunkt(r.assigned_at)] : null,
    r.fulfilled_at ? ["Sendt", tidspunkt(r.fulfilled_at)] : null,
    r.transferred_at ? ["Overført", `${tidspunkt(r.transferred_at)}${r.carrier ? " – " + esc(r.carrier) : ""}`] : null,
    r.manually_shipped_at ? ["Sendt manuelt", `${tidspunkt(r.manually_shipped_at)}${r.carrier ? " – " + esc(r.carrier) : ""}`] : null,
    r.pos_deducted_at ? ["Slått ut i kassa", `${tidspunkt(r.pos_deducted_at)}${r.pos_deducted_by ? " – " + esc(r.pos_deducted_by) : ""}`] : null,
    // Varer kunden har fått pengene tilbake for. Trekkes i oppgjøret; frakten er ikke med.
    r.refundert ? ["Refundert", `${kr(r.refundert)}${r.refundert_at ? " – " + tidspunkt(r.refundert_at) : ""}`] : null,
  ].filter(Boolean);

  const kanHenteEtikett = r.kind === "tildelt" && r.status !== "kansellert";
  const manglerUttrekk = r.kind === "tildelt" && r.fulfilled_at && !r.pos_deducted_at;

  el.detaljInnhold.innerHTML = `
    <div class="card__head">
      <span class="card__order">${esc(r.order_name ?? "Ordre")}${r.is_test ? ' <span class="merke">TEST</span>' : ""}</span>
      <span class="hist__status hist__status--${r.status}">${STATUSTEKST[r.status] ?? r.status}</span>
      ${kanHenteEtikett ? etikettIkon() : ""}
    </div>
    <ul class="lines">${lineItems(r.line_items)}</ul>
    ${adresse}
    ${pakkeboks(r)}
    ${r.tracking_number ? `<p class="track">Sporing: ${r.tracking_url ? `<a href="${esc(r.tracking_url)}" target="_blank" rel="noopener">${esc(r.tracking_number)}</a>` : esc(r.tracking_number)}</p>` : ""}
    ${tider.length ? `<dl class="tider">${tider.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
    ${manglerUttrekk ? `<div class="card__actions card__actions--etikett"><button class="btn btn--primary" data-act="deducted">Slått ut i kassa</button></div>` : ""}
  `;
  el.detalj.dataset.group = groupId;
  el.detalj.showModal();
}

function dato(iso) {
  return new Date(iso).toLocaleDateString("nb-NO", { day: "2-digit", month: "short" });
}

function tidspunkt(iso) {
  return new Date(iso).toLocaleString("nb-NO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Varelinjene butikken skal plukke.
 *
 * Kortet viste før bare produktnavnet – «Merinoull» – og butikken måtte gjette hvilket nøste
 * av tretti de skulle hente. Nå står varianten og strekkoden de skanner i kassa. Garnpakker
 * har ingen strekkode (variantene er størrelser), så der vises innholdet i pakken i stedet.
 *
 * Produktbilde ble prøvd og tatt bort igjen: butikken plukker på navn, farge og strekkode,
 * og bildet ble bare støy.
 *
 * Feltene kan mangle på ordrer rutet før 30.09.2026. Alt er derfor betinget.
 */
function lineItems(items) {
  return (items ?? []).map((i) => {
    const koder = [
      i.barcode ? `<code class="linje__ean">${esc(i.barcode)}</code>` : "",
      i.sku ? `<span class="linje__sku">SKU ${esc(i.sku)}</span>` : "",
    ].filter(Boolean).join(" ");
    const pakke = (i.kit_contents ?? []).length
      ? `<ul class="linje__pakke">${i.kit_contents.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>`
      : "";
    return `<li class="linje">
      <span class="linje__qty">${Number(i.qty)}</span>
      <div class="linje__tekst">
        <span class="linje__navn">${esc(i.title ?? "")}${i.variant_title ? ` – ${esc(i.variant_title)}` : ""}</span>
        ${koder ? `<span class="linje__koder">${koder}</span>` : ""}
        ${pakke}
      </div>
    </li>`;
  }).join("");
}

/** Liten ikonknapp for fraktetiketten. Samme markup på pakkekort og i tidligere ordrer. */
function etikettIkon() {
  return `<button class="ikon" data-act="etikett" title="Skriv ut fraktetikett" aria-label="Skriv ut fraktetikett">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 3h10v4H7z"/><path d="M5 7h14a2 2 0 0 1 2 2v6h-4v-2H7v2H3V9a2 2 0 0 1 2-2z"/><path d="M7 15h10v6H7z"/>
    </svg>
  </button>`;
}

// ---------------------------------------------------------------- svar

el.queue.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest("[data-offer]");
  const offerId = card.dataset.offer;
  const action = btn.dataset.act;
  // Ingen «Er du sikker?» på avslag: det kostet et ekstra trykk på hver eneste ordre, og et
  // avslag straffes ikke – ordren går bare videre til neste butikk.
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const ok = await respond(offerId, action);
  // Gikk det galt, må knappene tilbake: uten ny opptegning ville kortet blitt
  // liggende med nedtonede knapper som ikke lar seg trykke på.
  if (!ok) card.querySelectorAll("button").forEach((b) => (b.disabled = false));
  else queueSig = null;
  await refresh();
});

/**
 * Fraktetiketten fra ikonet på kortet.
 *
 * I «Til pakking» lager serveren sendingen i Cargonizer hvis den ikke finnes – uten å melde den
 * inn til PostNord; det skjer først ved «Slått ut og klar til sending». Har Garnly satt opp en
 * DirectPrint-skriver for butikken, går etiketten dit og svaret er JSON. Ellers kommer PDF-en,
 * som åpnes i ny fane. API-nøkkelen ligger på serveren.
 */
async function hentEtikett(btn, groupId) {
  // Ikonknappen har en SVG inni seg, ikke tekst. Skrev vi «Henter …» der, ville ikonet
  // forsvinne og aldri komme tilbake om noe feilet.
  const ikon = btn.classList.contains("ikon");
  const original = ikon ? null : btn.textContent;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  if (!ikon) btn.textContent = "Henter …";
  let url = null;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showLogin(); return; }
    const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/shipping-label`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ group_id: groupId }),
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(30000) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.message || "Fikk ikke hentet etiketten.", "error");
      return;
    }
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      const svar = await res.json().catch(() => ({}));
      if (svar.etikett === "skriver") toast("Etiketten skrives ut.");
      return;
    }
    // Åpnes i ny fane så butikken kan skrive ut eller lagre. Uten window.open-sjekken
    // forsvinner etiketten sporløst hvis nettleseren blokkerer popup.
    url = URL.createObjectURL(await res.blob());
    const vindu = window.open(url, "_blank");
    if (!vindu) {
      const a = document.createElement("a");
      a.href = url;
      a.download = `fraktetikett-${groupId.slice(0, 8)}.pdf`;
      a.click();
    }
  } catch (err) {
    console.error("[shipping-label]", err);
    const grunn = err?.name === "TimeoutError" ? "Svaret tok for lang tid." : String(err?.message ?? err);
    toast(`Fikk ikke hentet etiketten: ${grunn}`, "error");
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    if (original !== null) btn.textContent = original;
    // Gi nettleseren tid til å åpne fila før vi frigjør den.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
    // Kortet i «Til pakking» skal vise «Etikett skrevet ut», sporing og pakkeboks med en gang.
    if (btn.closest("#assigned")) { assignedSig = null; await refresh(); }
  }
}

// «Slått ut i kassa». Går via en RPC og ikke rett på tabellen: panelet skal ikke ha
// skriverett på routing_groups, og RPC-en sjekker selv at gruppen hører til butikken.
el.assigned.addEventListener("click", async (e) => {
  const etikettBtn = e.target.closest('button[data-act="etikett"]');
  if (etikettBtn) {
    const kort = etikettBtn.closest("[data-group]");
    if (kort?.dataset.group) await hentEtikett(etikettBtn, kort.dataset.group);
    return;
  }
  const sendBtn = e.target.closest('button[data-act="send"]');
  if (sendBtn) {
    const kort = sendBtn.closest("[data-group]");
    if (kort?.dataset.group) await sendOrdre(sendBtn, kort.dataset.group);
    return;
  }
  const btn = e.target.closest('button[data-act="deducted"]');
  if (!btn) return;
  const card = btn.closest("[data-group]");
  const groupId = card?.dataset.group;
  if (!groupId || busy.has(groupId)) return;
  busy.add(groupId);
  btn.disabled = true;
  try {
    const { error } = await sb.rpc("mark_pos_deducted", { p_group_id: groupId });
    if (error) throw new Error(error.message);
    toast("Registrert. Lageret oppdateres ved neste synk.");
    assignedSig = null;
    await refresh();
  } catch (err) {
    console.error("[mark_pos_deducted]", err);
    toast(`Fikk ikke registrert uttrekket: ${String(err?.message ?? err)}`, "error");
    btn.disabled = false;
  } finally {
    busy.delete(groupId);
  }
});

/**
 * «Slått ut og klar til sending».
 *
 * Panelet gjør ingenting av dette selv. Alt – kassauttrekk, sending i Cargonizer, overføring
 * til PostNord, fulfillment i Shopify og etiketten – ligger i ship-order på serveren. Her
 * sender vi trykket og viser hva som skjedde.
 *
 * Svaret er 200 også når et steg feilet, med `utfort` som sier hva som gikk gjennom. Derfor
 * leser vi `ok` og ikke HTTP-statusen: butikken skal se at uttrekket er registrert selv om
 * fraktsendingen stoppet.
 */
async function sendOrdre(btn, groupId) {
  if (busy.has(groupId)) return;
  busy.add(groupId);
  const kort = btn.closest("[data-group]");
  kort?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const original = btn.textContent;
  btn.textContent = "Sender …";
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showLogin(); return; }
    const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/ship-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ group_id: groupId }),
      // Sendingen går innom Cargonizer og Shopify. 60 sekunder er rundhåndet, men et
      // tidsavbrudd midt i ville sett ut som om ingenting skjedde – og noe har skjedd.
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(60000) : undefined,
    });
    const svar = await res.json().catch(() => ({}));
    if (!svar.ok) {
      toast(svar.melding || "Noe stoppet. Prøv igjen.", "error");
      return;
    }
    // Etiketten lastes IKKE ned av seg selv. Har Garnly satt opp en DirectPrint-skriver for
    // butikken, er den alt på vei dit. Er den ikke satt, henter butikken PDF-en med ikonet
    // på kortet når de vil – en PDF som åpner seg i en ny fane midt i pakkingen er i veien.
    // Skrevet ut alt fra «Til pakking» («allerede»): da sier vi ingenting om etiketten.
    toast(svar.etikett === "skriver"
      ? "Sendt. Etiketten skrives ut."
      : "Sendt. Du finner den under Tidligere ordrer.");
  } catch (err) {
    console.error("[ship-order]", err);
    const grunn = err?.name === "TimeoutError" ? "Svaret tok for lang tid. Sjekk kortet før du prøver igjen." : String(err?.message ?? err);
    toast(`Fikk ikke sendt ordren: ${grunn}`, "error");
  } finally {
    busy.delete(groupId);
    btn.textContent = original;
    assignedSig = null;
    await refresh();
  }
}

// ---------------------------------------------------------------- innstillinger

/**
 * Butikkens egen innstilling: automatisk godkjenning.
 *
 * Lagringen går via serveren, ikke rett på tabellen: panelet har ikke skriverett på `stores`,
 * og endringen skal i revisjonsloggen.
 *
 * Etikettskriveren lå her før. DirectPrint er Garnlys oppsett, ikke noe butikken skal
 * forholde seg til – de merker bare forskjellen på om etiketten kommer ut av seg selv eller
 * må hentes med ikonet på kortet.
 */
let autoVarFor = false;

el.innstillinger.addEventListener("click", async () => {
  el.autoGodkjenn.disabled = true;
  el.innstillingerDialog.showModal();
  const svar = await kallInnstillinger({ action: "les" });
  if (!svar) return;
  tegnInnstillinger(svar);
});

el.innstillingerLukk.addEventListener("click", () => el.innstillingerDialog.close());

el.innstillingerLagre.addEventListener("click", async () => {
  const auto = el.autoGodkjenn.checked;
  // Å skru PÅ automatisk godkjenning betyr at ordrer blir butikkens uten at noen ser på dem,
  // og de kan ikke avslå etterpå. Det skal ikke skje med et uhell på et nettbrett.
  if (auto && !autoVarFor &&
      !confirm("Skru på automatisk godkjenning?\n\nOrdrer dere får tilbud om blir deres med en gang, og dere kan ikke avslå dem etterpå.")) {
    return;
  }
  el.innstillingerLagre.disabled = true;
  const svar = await kallInnstillinger({ action: "lagre", auto_accept: auto });
  el.innstillingerLagre.disabled = false;
  if (!svar) return;
  tegnInnstillinger(svar);
  toast(svar.auto_accept ? "Nye ordrer godtas automatisk." : "Nye ordrer må godtas manuelt.");
  el.innstillingerDialog.close();
});

function tegnInnstillinger(svar) {
  autoVarFor = svar.auto_accept === true;
  el.autoGodkjenn.checked = autoVarFor;
  el.autoGodkjenn.disabled = false;
  autoGodkjenning = autoVarFor;
  tegnKoStatus();
}

async function kallInnstillinger(body) {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showLogin(); return null; }
    const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/store-settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ ...body, store_id: storeId }),
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(30000) : undefined,
    });
    const svar = await res.json().catch(() => ({}));
    if (!svar.ok) { toast(svar.melding || "Fikk ikke hentet innstillingene.", "error"); return null; }
    return svar;
  } catch (err) {
    console.error("[store-settings]", err);
    toast(`Fikk ikke hentet innstillingene: ${String(err?.message ?? err)}`, "error");
    return null;
  }
}

/**
 * Står automatisk godkjenning på, kommer ordrene rett i pakkelista og «Nye ordrer» er tom
 * hele dagen. Uten en forklaring der ser det ut som om panelet ikke virker.
 */
function tegnKoStatus() {
  el.queueEmpty.innerHTML = autoGodkjenning
    ? 'Ingen nye ordrer akkurat nå.<br><span>Automatisk godkjenning er på, så ordrer går rett til «Til pakking».</span>'
    : 'Ingen nye ordrer akkurat nå.<br><span>Panelet varsler av seg selv når det kommer en.</span>';
}

// ---------------------------------------------------------------- faner og historikk

const FANER = {
  aktive: [el.faneAktive, el.visningAktive],
  historikk: [el.faneHistorikk, el.visningHistorikk],
  garnly: [el.faneGarnly, el.visningGarnly],
};

function velgFane(navn) {
  for (const [n, [fane, visning]] of Object.entries(FANER)) {
    const valgt = n === navn;
    visning.hidden = !valgt;
    fane.classList.toggle("fane--valgt", valgt);
    fane.setAttribute("aria-selected", String(valgt));
  }
  // Hentes først når fanen faktisk åpnes: butikken har panelet stående hele dagen, og
  // historikken trenger ikke lastes på nytt hvert 20. sekund sammen med køen.
  if (navn === "historikk") lastHistorikk();
  if (navn === "garnly") lastAdmin();
}

el.faneAktive.addEventListener("click", () => velgFane("aktive"));
el.faneHistorikk.addEventListener("click", () => velgFane("historikk"));
el.faneGarnly.addEventListener("click", () => velgFane("garnly"));

el.sok.addEventListener("input", () => {
  // Debounce: uten den ville hvert tastetrykk blitt et kall til basen.
  clearTimeout(sokTimer);
  sokTimer = setTimeout(() => { historikkGrense = HISTORIKK_SIDE; lastHistorikk(); }, 300);
});

el.visFlere.addEventListener("click", () => {
  // Utvider både antall og datovindu: «vis flere» skal også nå lenger bakover enn 30 dager.
  historikkGrense += HISTORIKK_SIDE;
  historikkDager += 60;
  lastHistorikk();
});

el.historikk.addEventListener("click", async (e) => {
  const kort = e.target.closest("[data-group]");
  if (!kort?.dataset.group) return;
  // Etikettikonet ligger inne i kortet, som selv er klikkbart. Uten denne ville et trykk på
  // ikonet både hentet etiketten og åpnet detaljruten oppå den.
  const etikett = e.target.closest('button[data-act="etikett"]');
  if (etikett) { await hentEtikett(etikett, kort.dataset.group); return; }
  apneDetalj(kort.dataset.group);
});
el.historikk.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  // Knapper inne i kortet lager sin egen click av Enter og mellomrom. Uten dette ville
  // detaljruten åpnet seg i tillegg.
  if (e.target.closest("button")) return;
  const kort = e.target.closest("[data-group]");
  if (!kort?.dataset.group) return;
  e.preventDefault();
  apneDetalj(kort.dataset.group);
});

el.detaljLukk.addEventListener("click", () => el.detalj.close());

el.detaljInnhold.addEventListener("click", async (e) => {
  const groupId = el.detalj.dataset.group;
  if (!groupId) return;
  const etikett = e.target.closest('button[data-act="etikett"]');
  if (etikett) { await hentEtikett(etikett, groupId); return; }

  const uttrekk = e.target.closest('button[data-act="deducted"]');
  if (!uttrekk) return;
  uttrekk.disabled = true;
  try {
    const { error } = await sb.rpc("mark_pos_deducted", { p_group_id: groupId });
    if (error) throw new Error(error.message);
    toast("Registrert. Lageret oppdateres ved neste synk.");
    el.detalj.close();
    assignedSig = null;
    await Promise.all([refresh(), lastHistorikk()]);
  } catch (err) {
    console.error("[mark_pos_deducted]", err);
    toast(`Fikk ikke registrert uttrekket: ${String(err?.message ?? err)}`, "error");
    uttrekk.disabled = false;
  }
});

el.acceptAll.addEventListener("click", async () => {
  const ids = [...el.queue.querySelectorAll("[data-offer]")].map((c) => c.dataset.offer);
  if (!ids.length || !confirm(`Godta alle ${ids.length} ordrene?`)) return;
  el.acceptAll.disabled = true;
  let ok = 0, failed = 0;
  for (const id of ids) {
    const r = await respond(id, "accept", true);
    r ? ok++ : failed++;
  }
  el.acceptAll.disabled = false;
  toast(failed ? `${ok} godtatt, ${failed} gikk ikke gjennom.` : `${ok} ordrer godtatt.`, failed ? "error" : "");
  await refresh();
});

async function respond(offerId, action, quiet = false) {
  if (busy.has(offerId)) return false;
  busy.add(offerId);
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showLogin(); return false; }
    const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/offer-respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ offer_id: offerId, action }),
      // AbortSignal.timeout mangler i eldre nettlesere (Safari under 16). Uten
      // sjekken kaster selve oppsettet, og det ser ut som nettverksfeil.
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(20000) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!quiet) toast(body.message || (res.ok ? "Sendt." : "Noe gikk galt."), body.ok ? "" : "error");
    return Boolean(body.ok);
  } catch (err) {
    // Ikke skjul årsaken: CORS-blokkering, avbrutt kall og nedlagt nett gir alle
    // samme unntak her, og uten teksten er de umulige å skille fra hverandre.
    console.error("[offer-respond]", err);
    const grunn = err?.name === "TimeoutError" ? "Svaret tok for lang tid." : String(err?.message ?? err);
    if (!quiet) toast(`Fikk ikke kontakt med Garnly: ${grunn}`, "error");
    return false;
  } finally {
    busy.delete(offerId);
  }
}

// ---------------------------------------------------------------- frister

function tickDeadlines() {
  for (const card of el.queue.querySelectorAll("[data-deadline]")) {
    const iso = card.dataset.deadline;
    if (!iso) continue;
    const span = card.querySelector(".card__deadline");
    const level = deadlineLevel(iso);
    if (span) { span.textContent = countdown(iso); span.dataset.level = level; }
    card.classList.remove("card--soon", "card--late");
    if (!card.classList.contains("card--new")) card.classList.add(`card--${level}`);
  }
}

function deadlineLevel(iso) {
  if (!iso) return "new";
  const left = new Date(iso) - Date.now();
  if (left <= 0) return "late";
  if (left < 30 * 60 * 1000) return "late";
  if (left < 60 * 60 * 1000) return "soon";
  return "new";
}

function countdown(iso) {
  if (!iso) return "";
  let s = Math.floor((new Date(iso) - Date.now()) / 1000);
  if (s <= 0) return "fristen er ute";
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return h ? `${h} t ${String(m).padStart(2, "0")} min` : `${m}:${String(s).padStart(2, "0")}`;
}

function klokke(iso) {
  return new Date(iso).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------- varsling

function notifyNew(n) {
  beep();
  toast(n === 1 ? "Ny ordre kom inn." : `${n} nye ordrer kom inn.`);
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Garnly", { body: n === 1 ? "Ny ordre venter på svar" : `${n} nye ordrer venter på svar` });
  }
}

let audioCtx = null;
function primeSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch { /* lyd er en bonus, ikke et krav */ }
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
}

function beep() {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.18);
      osc.stop(now + i * 0.18 + 0.18);
    });
  } catch { /* ignorer */ }
}

async function keepAwake() {
  try {
    if ("wakeLock" in navigator) {
      let lock = await navigator.wakeLock.request("screen");
      document.addEventListener("visibilitychange", async () => {
        if (!document.hidden) { try { lock = await navigator.wakeLock.request("screen"); } catch { /* ignorer */ } }
      });
    }
  } catch { /* ikke kritisk */ }
}

// ---------------------------------------------------------------- småting

let toastTimer = null;
function toast(msg, kind = "") {
  el.toast.textContent = msg;
  el.toast.dataset.kind = kind;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), kind === "error" ? 7000 : 4000);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- Garnly-admin

/**
 * Admin-fanen.
 *
 * Alt her kommer fra v_admin_*-viewene, som filtrerer på is_garnly_admin() og gir en
 * butikkbruker null rader. Handlingene går til `admin-actions`, som sjekker rollen på nytt –
 * et view som returnerer ingenting er nok til å skjule data, men ikke til å hindre en POST.
 */
const ORDRESTATUS = {
  routing: "Ute på tilbud",
  assigned: "Til pakking",
  fulfilled: "Sendt",
  escalated: "Trenger handling",
  cancelled: "Kansellert",
};

let adminOrdrer = [];
let adminHandling = [];

function klargjorAdminfiltre() {
  el.filterButikk.innerHTML = '<option value="">Alle butikker</option>' +
    alleButikker.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
  el.filterStatus.innerHTML = '<option value="">Alle statuser</option>' +
    Object.entries(ORDRESTATUS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  el.giButikk.innerHTML = alleButikker.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
}

async function lastAdmin() {
  if (!erAdmin) return;
  const [tall, handling, ordrer, synk] = await Promise.all([
    sb.from("v_admin_stats").select("*").maybeSingle(),
    sb.from("v_admin_action_needed").select("*").order("ventet_siden", { ascending: true }),
    sb.from("v_admin_orders").select("*").order("order_created_at", { ascending: false }).limit(200),
    sb.from("v_admin_sync").select("*").order("butikk"),
  ]);
  adminHandling = handling.data ?? [];
  adminOrdrer = ordrer.data ?? [];
  tegnTall(tall.data);
  tegnHandling();
  tegnSynk(synk.data ?? []);
  tegnOrdrer();
}

function tegnTall(t) {
  if (!t) return;
  const tall = [
    ["Trenger handling", t.trenger_handling, t.trenger_handling > 0 ? "alarm" : ""],
    ["Ute på tilbud", t.ute_pa_tilbud, ""],
    ["Til pakking", t.til_pakking, ""],
    ["Venter kassauttrekk", t.venter_kassauttrekk, ""],
    ["Tildelt i dag", t.tildelt_i_dag, ""],
    ["Butikker med synkfeil", t.butikker_med_synkfeil, t.butikker_med_synkfeil > 0 ? "alarm" : ""],
  ];
  el.adminTall.innerHTML = tall.map(([navn, verdi, kls]) =>
    `<div class="tall__kort ${kls}"><b>${Number(verdi ?? 0)}</b><span>${navn}</span></div>`).join("");
}

function tegnHandling() {
  el.adminHandlingTom.hidden = adminHandling.length > 0;
  el.adminHandling.innerHTML = adminHandling.map((r) => {
    const svar = (r.svar ?? []).map((s) =>
      `<li>${esc(s.butikk)}: ${esc(AVSLAGSTEKST[s.status] ?? s.status)}${s.begrunnelse ? ` – ${esc(s.begrunnelse)}` : ""}</li>`).join("");
    const ventet = ventetid(r.ventet_siden);
    const slettes = r.arsak === "sending_ma_slettes";
    const feilet = r.arsak === "sending_feilet" || slettes;
    const hva = r.arsak === "eskalert" ? "Ingen butikk kunne ta den"
      : slettes ? `Kansellert – sendingen hos ${esc(r.store_name ?? "")} må slettes i Cargonizer`
      : feilet ? `Sendingen stoppet hos ${esc(r.store_name ?? "")}`
      : `Frist gikk ut hos ${esc(r.store_name ?? "")}`;
    const shopify = `<a class="btn btn--ghost btn--sm" data-act="shopify" target="_blank" rel="noopener"
           href="${esc(shopifyOrdreLenke(r.shopify_order_id))}">Åpne i Shopify</a>`;
    // En feilet sending er alt butikkens: den skal ikke gis bort eller rutes på nytt, men sendes
    // manuelt og fulfilles i Shopify. Da lukker webhooken den av seg selv.
    const knapper = feilet
      ? `<div class="card__actions card__actions--etikett">${shopify}</div>`
      : `<div class="card__actions card__actions--tre">
        <button class="btn btn--primary btn--sm" data-act="gi">Gi til butikk</button>
        <button class="btn btn--secondary btn--sm" data-act="ruting">Prøv ruting på nytt</button>
        ${shopify}
      </div>`;
    return `<article class="card card--late" data-group="${esc(r.group_id)}" data-ordre="${esc(r.order_name ?? "")}" data-shopify="${esc(r.shopify_order_id ?? "")}">
      <div class="card__head">
        <span class="card__order">${esc(r.order_name ?? "Ordre")}${r.is_test ? ' <span class="merke">TEST</span>' : ""}</span>
        <span class="card__meta">${hva} · ventet ${ventet}</span>
      </div>
      <ul class="lines">${lineItems(r.line_items)}</ul>
      <p class="addr">${esc(r.kunde ?? "")}${r.kunde_postnr ? ` – ${esc(r.kunde_postnr)} ${esc(r.kunde_sted ?? "")}` : ""}</p>
      ${feilet && r.feilmelding ? `<p class="feil" role="alert">${esc(r.feilmelding)}</p>` : ""}
      ${svar ? `<ul class="avslag">${svar}</ul>` : ""}
      ${knapper}
    </article>`;
  }).join("");
}

const AVSLAGSTEKST = {
  declined: "avslo",
  declined_stock: "ikke nok på lager",
  expired: "svarte ikke innen fristen",
  cancelled: "tilbudet ble trukket",
};

/** Kansellering og refusjon gjøres av et menneske i Shopify, ikke herfra. */
function shopifyOrdreLenke(gid) {
  const id = String(gid ?? "").split("/").pop();
  return id ? `https://admin.shopify.com/store/${CFG.SHOPIFY_STORE ?? "fhxr10-gu"}/orders/${id}` : "#";
}

function ventetid(fra) {
  if (!fra) return "–";
  const min = Math.round((Date.now() - new Date(fra).getTime()) / 60000);
  if (min < 60) return `${min} min`;
  const t = Math.floor(min / 60);
  return t < 48 ? `${t} t` : `${Math.floor(t / 24)} døgn`;
}

function tegnSynk(rader) {
  el.adminSynk.innerHTML = rader.map((r) => {
    const feiler = r.consecutive_sync_failures > 0 || r.last_sync_status !== "ok";
    const gammel = r.last_sync_at && Date.now() - new Date(r.last_sync_at).getTime() > 90 * 60000;
    const niva = feiler ? "feil" : gammel ? "gammel" : "ok";
    const tekst = feiler
      ? `Siste forsøk feilet (${r.consecutive_sync_failures} på rad)`
      : gammel ? "Ingen synk på over en time" : `${r.last_sync_rows ?? 0} varer, oppdatert ${r.last_sync_at ? klokke(r.last_sync_at) : "aldri"}`;
    return `<article class="synk synk--${niva}">
      <div class="synk__topp">
        <span class="synk__prikk" aria-hidden="true"></span>
        <b>${esc(r.butikk)}</b> <span class="synk__pos">${esc(r.pos_system)}</span>
      </div>
      <p class="synk__tekst">${esc(tekst)}</p>
      ${r.siste_feil?.feil ? `<p class="synk__feil">Siste feil ${tidspunkt(r.siste_feil.nar)}: ${esc(String(r.siste_feil.feil).slice(0, 180))}</p>` : ""}
      ${r.feil_siste_uke > 0 ? `<p class="synk__tekst">${r.feil_siste_uke} feil siste uke</p>` : ""}
    </article>`;
  }).join("");
}

function tegnOrdrer() {
  const butikk = el.filterButikk.value, status = el.filterStatus.value, visTest = el.filterTest.checked;
  const rader = adminOrdrer.filter((r) =>
    (visTest || !r.is_test) &&
    (!butikk || r.store_id === butikk) &&
    (!status || r.group_status === status));
  el.adminOrdrerTom.hidden = rader.length > 0;
  el.adminOrdrer.innerHTML = rader.length
    ? `<table><thead><tr><th>Ordre</th><th>Status</th><th>Butikk</th><th>Frist</th><th>Sporing</th></tr></thead><tbody>${
      rader.map((r) => `<tr>
        <td>${esc(r.order_name ?? "")}${r.is_test ? ' <span class="merke">TEST</span>' : ""}<br><span class="svak">${esc(r.kunde ?? "")}</span></td>
        <td>${esc(ORDRESTATUS[r.group_status] ?? r.group_status)}${r.ship_error ? '<br><span class="svak svak--feil">stoppet ved sending</span>' : ""}</td>
        <td>${esc(r.store_name ?? r.tilbudt_butikk ?? "–")}</td>
        <td>${r.deadline_at ? tidspunkt(r.deadline_at) : "–"}</td>
        <td>${r.tracking_number ? (r.tracking_url ? `<a href="${esc(r.tracking_url)}" target="_blank" rel="noopener">${esc(r.tracking_number)}</a>` : esc(r.tracking_number)) : "–"}</td>
      </tr>`).join("")}</tbody></table>`
    : "";
}

function kroner(v) {
  return Number(v ?? 0).toLocaleString("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 });
}

/** Kroner med øre. Refusjonen skal stemme på øret; kroner() runder til hele kroner. */
function kr(v) {
  return Number(v ?? 0).toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";
}

for (const elm of [el.filterButikk, el.filterStatus, el.filterTest]) elm.addEventListener("change", tegnOrdrer);

el.adminHandling.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const kort = btn.closest("[data-group]");
  if (!kort) return;
  if (btn.dataset.act === "gi") {
    el.giDialog.dataset.group = kort.dataset.group;
    el.giOrdre.textContent = `${kort.dataset.ordre || "Ordren"} – velg butikken som skal få tilbudet.`;
    el.giDialog.showModal();
    return;
  }
  if (btn.dataset.act === "ruting") {
    btn.disabled = true;
    await adminHandling_kall({ action: "prov_ruting", group_id: kort.dataset.group });
    btn.disabled = false;
  }
});

el.giLukk.addEventListener("click", () => el.giDialog.close());
el.giSend.addEventListener("click", async () => {
  el.giSend.disabled = true;
  const ok = await adminHandling_kall({
    action: "gi_til_butikk",
    group_id: el.giDialog.dataset.group,
    store_id: el.giButikk.value,
  });
  el.giSend.disabled = false;
  if (ok) el.giDialog.close();
});

async function adminHandling_kall(body) {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showLogin(); return false; }
    const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/admin-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(45000) : undefined,
    });
    const svar = await res.json().catch(() => ({}));
    toast(svar.melding || (svar.ok ? "Gjort." : "Noe gikk galt."), svar.ok ? undefined : "error");
    await lastAdmin();
    return svar.ok === true;
  } catch (err) {
    console.error("[admin-actions]", err);
    toast(`Handlingen feilet: ${String(err?.message ?? err)}`, "error");
    return false;
  }
}
