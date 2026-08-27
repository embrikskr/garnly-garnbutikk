/**
 * Shipmondo via REST-API (POST /shipments), jf. Garnly_Ordreruting_Teknisk_Oppsett.md §15.
 * Docs: https://shipmondo.dev/api-reference/#/operations/shipments_post
 *
 * Env: SHIPMONDO_USER, SHIPMONDO_KEY, SHIPMONDO_PRODUCT_CODE (f.eks. Bring "BRPP" – hent fra /products),
 *      SHIPMONDO_SERVICE_CODES (kommaseparert), SHIPMONDO_SANDBOX=true for test.
 * Butikkens avsender: stores.shipping_sender_id (Shipmondo sender_id) – ellers bygges avsender fra pos_config.address.
 *
 * Vekt: 100 g per nøste som standard (SHIPMONDO_GRAMS_PER_ITEM). Byttes til vekt per produkt når produktdata har det.
 */
import type { ShipmentRequest, ShipmentResult } from "./index.ts";

export async function shipmondoBook({ store, order, items }: ShipmentRequest): Promise<ShipmentResult> {
  const user = Deno.env.get("SHIPMONDO_USER"), key = Deno.env.get("SHIPMONDO_KEY");
  if (!user || !key) throw new Error("SHIPMONDO_USER / SHIPMONDO_KEY mangler");
  const base = Deno.env.get("SHIPMONDO_SANDBOX") === "true" ? "https://sandbox.shipmondo.com/api/public/v3" : "https://app.shipmondo.com/api/public/v3";
  const grams = Number(Deno.env.get("SHIPMONDO_GRAMS_PER_ITEM") ?? 100);
  const c = order.customer;
  const address = (store.pos_config.address ?? {}) as Record<string, string>;

  const body: Record<string, unknown> = {
    test_mode: Deno.env.get("SHIPMONDO_SANDBOX") === "true",
    own_agreement: true,
    product_code: Deno.env.get("SHIPMONDO_PRODUCT_CODE"),
    service_codes: Deno.env.get("SHIPMONDO_SERVICE_CODES") ?? "",
    reference: order.shopify_order_name,
    sender: store.shipping_sender_id ? { id: Number(store.shipping_sender_id) } : {
      name: store.name, address1: address.address1, zipcode: address.zip, city: address.city, country_code: "NO",
      email: store.contact_email, telephone: store.contact_phone,
    },
    receiver: {
      name: c.name, address1: c.address1, address2: c.address2 ?? undefined, zipcode: c.zip, city: c.city,
      country_code: c.countryCodeV2 ?? "NO", email: c.email ?? undefined, telephone: c.phone ?? undefined,
    },
    parcels: [{ weight: Math.max(100, items.reduce((s, i) => s + i.qty * grams, 0)) }],
    print: !!store.pos_config.shipmondo_printer_id,
    print_at: store.pos_config.shipmondo_printer_id ? { printer_id: Number(store.pos_config.shipmondo_printer_id) } : undefined,
  };

  const res = await fetch(`${base}/shipments`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${user}:${key}`), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shipmondo ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const pkg = json.parcels?.[0] ?? {};
  return {
    id: String(json.id),
    trackingNumber: pkg.pkg_no ?? json.pkg_no ?? "",
    trackingUrl: pkg.tracking_url ?? undefined,
    labelUrl: json.label_url ?? undefined,
    carrier: json.carrier_code ?? "Bring",
  };
}
