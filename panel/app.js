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
  statQueue: $("stat-queue"), statPack: $("stat-pack"), statToday: $("stat-today"),
  acceptAll: $("accept-all"), logout: $("logout"), toast: $("toast"),
  conn: $("conn"), soundToggle: $("sound-toggle"),
};

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

el.logout.addEventListener("click", () => sb.auth.signOut());

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
  el.login.hidden = true;
  el.app.hidden = false;
  el.soundToggle.textContent = soundOn ? "🔔" : "🔕";

  const { data, error } = await sb.from("stores").select("id, name").order("name");
  if (error || !data?.length) {
    toast("Brukeren er ikke koblet til en butikk. Ta kontakt med Garnly.", "error");
    return;
  }
  stores = data;
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
  clearInterval(pollTimer); clearInterval(tickTimer);
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
  const [queue, assigned, stats] = await Promise.all([
    sb.from("v_panel_queue").select("*").eq("store_id", storeId).order("deadline_at", { ascending: true }),
    sb.from("v_panel_assigned").select("*").eq("store_id", storeId).order("assigned_at", { ascending: false }),
    sb.from("v_panel_stats").select("*").eq("store_id", storeId).maybeSingle(),
  ]);

  const rows = queue.data ?? [];
  const fresh = rows.filter((r) => !knownOfferIds.has(r.offer_id));
  if (!firstLoad && fresh.length) notifyNew(fresh.length);
  knownOfferIds = new Set(rows.map((r) => r.offer_id));
  firstLoad = false;

  renderQueue(rows, fresh.map((r) => r.offer_id));
  renderAssigned(assigned.data ?? []);

  el.statQueue.textContent = stats.data?.queue ?? rows.length;
  el.statPack.textContent = stats.data?.to_pack ?? (assigned.data?.length ?? 0);
  el.statToday.textContent = stats.data?.assigned_today ?? 0;
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
  const html = rows.map((r) => `
    <article class="card card--packing">
      <div class="card__head">
        <span class="card__order">${esc(r.order_name ?? "Ordre")}</span>
        <span class="card__meta">${r.assigned_at ? klokke(r.assigned_at) : ""}</span>
      </div>
      <ul class="lines">${lineItems(r.line_items)}</ul>
      <p class="addr">${esc(r.ship_name ?? "")}<br>${esc(r.ship_address1 ?? "")}${r.ship_address2 ? "<br>" + esc(r.ship_address2) : ""}<br>${esc(r.ship_zip ?? "")} ${esc(r.ship_city ?? "")}</p>
      ${r.tracking_number ? `<p class="track">Sporing: ${r.tracking_url ? `<a href="${esc(r.tracking_url)}" target="_blank" rel="noopener">${esc(r.tracking_number)}</a>` : esc(r.tracking_number)}</p>` : ""}
    </article>`).join("");
  if (html === assignedSig) return;
  assignedSig = html;
  el.assigned.innerHTML = html;
}

function lineItems(items) {
  return (items ?? []).map((i) => `<li><span class="qty">${Number(i.qty)}</span><span>${esc(i.title ?? "")}</span></li>`).join("");
}

// ---------------------------------------------------------------- svar

el.queue.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest("[data-offer]");
  const offerId = card.dataset.offer;
  const action = btn.dataset.act;
  if (action === "decline" && !confirm("Avslå denne ordren? Den går videre til neste butikk.")) return;
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const ok = await respond(offerId, action);
  // Gikk det galt, må knappene tilbake: uten ny opptegning ville kortet blitt
  // liggende med nedtonede knapper som ikke lar seg trykke på.
  if (!ok) card.querySelectorAll("button").forEach((b) => (b.disabled = false));
  else queueSig = null;
  await refresh();
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
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!quiet) toast(body.message || (res.ok ? "Sendt." : "Noe gikk galt."), body.ok ? "" : "error");
    return Boolean(body.ok);
  } catch (err) {
    if (!quiet) toast("Fikk ikke kontakt med Garnly. Prøv igjen.", "error");
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
