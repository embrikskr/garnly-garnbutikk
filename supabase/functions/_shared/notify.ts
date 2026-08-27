/**
 * Varsling til butikker og Garnly ops.
 * E-post via Resend (RESEND_API_KEY, NOTIFY_FROM), SMS via Twilio (TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM).
 * Mangler nøkler, logges meldingen bare (nyttig i test).
 */
import type { LineItem, StoreRow } from "./types.ts";

export async function sendEmail(to: string, subject: string, html: string, text?: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("NOTIFY_FROM") ?? "Garnly <ordre@garnly.no>";
  if (!key) { console.log(`[email→${to}] ${subject}\n${text ?? html}`); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) console.error("Resend feilet:", res.status, await res.text());
}

export async function sendSms(to: string, body: string) {
  const sid = Deno.env.get("TWILIO_SID"), token = Deno.env.get("TWILIO_TOKEN"), from = Deno.env.get("TWILIO_FROM");
  if (!sid || !token || !from) { console.log(`[sms→${to}] ${body}`); return; }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) console.error("Twilio feilet:", res.status, await res.text());
}

export async function notifyStoreOffer(store: StoreRow, orderName: string, items: LineItem[], deadline: Date, links: { accept: string; decline: string }) {
  const deadlineStr = deadline.toLocaleString("nb-NO", { timeZone: "Europe/Oslo", weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  const lines = items.map((i) => `${i.qty} × ${i.title}`);
  const subject = `Ny Garnly-ordre ${orderName} – svar innen ${deadlineStr}`;
  const text = [
    `Hei ${store.name}!`, "",
    `Dere har fått tilbud om Garnly-ordre ${orderName}:`, ...lines.map((l) => "  • " + l), "",
    `Sjekk at dere har alt på lager, og svar innen ${deadlineStr}.`, "",
    `GODTA:  ${links.accept}`, `AVSLÅ:  ${links.decline}`, "",
    "Svarer dere ikke innen fristen, går ordren videre til neste butikk.",
  ].join("\n");
  const html = `<p>Hei ${store.name}!</p><p>Dere har fått tilbud om Garnly-ordre <b>${orderName}</b>:</p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>
<p>Sjekk at dere har alt på lager, og svar innen <b>${deadlineStr}</b>.</p>
<p><a href="${links.accept}" style="background:#5F0B09;color:#F7F2EA;padding:12px 24px;border-radius:10px;text-decoration:none;display:inline-block">Godta ordren</a>
&nbsp; <a href="${links.decline}" style="color:#5F0B09;padding:12px 24px;display:inline-block">Avslå</a></p>
<p style="color:#666">Svarer dere ikke innen fristen, går ordren videre til neste butikk.</p>`;

  const tasks: Promise<void>[] = [];
  if ((store.notify_channel === "email" || store.notify_channel === "both") && store.contact_email) tasks.push(sendEmail(store.contact_email, subject, html, text));
  if ((store.notify_channel === "sms" || store.notify_channel === "both") && store.contact_phone) {
    tasks.push(sendSms(store.contact_phone, `Garnly-ordre ${orderName}: ${lines.join(", ")}. Svar innen ${deadlineStr}. Godta: ${links.accept}`));
  }
  await Promise.all(tasks);
}

export async function notifyOps(subject: string, text: string) {
  const to = Deno.env.get("OPS_EMAIL");
  if (!to) { console.warn("[ops] " + subject + "\n" + text); return; }
  await sendEmail(to, "[Garnly ops] " + subject, `<pre>${text}</pre>`, text);
}
