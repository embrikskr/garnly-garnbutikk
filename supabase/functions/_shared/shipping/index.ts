/**
 * Fraktadaptere. Valg styres av env SHIPPING_PROVIDER = shipmondo | cargonizer | none (default none).
 * Byggeplan §10: signaturbeslutning Shipmondo vs Cargonizer er fortsatt åpen; begge kan kobles på her.
 */
import type { LineItem, StoreRow } from "../types.ts";
import { shipmondoBook } from "./shipmondo.ts";

export interface ShipmentRequest {
  store: StoreRow;
  order: { shopify_order_name: string; customer: Record<string, string | null> };
  items: LineItem[];
}

export interface ShipmentResult {
  id: string;
  trackingNumber: string;
  trackingUrl?: string;
  labelUrl?: string;
  carrier: string;
}

export async function bookShipment(req: ShipmentRequest): Promise<ShipmentResult | null> {
  const provider = Deno.env.get("SHIPPING_PROVIDER") ?? "none";
  switch (provider) {
    case "shipmondo":
      return shipmondoBook(req);
    case "none":
      return null;
    default:
      throw new Error(`Ukjent SHIPPING_PROVIDER: ${provider}`);
  }
}
