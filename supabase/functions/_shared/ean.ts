/**
 * Én EAN, én variant. `products.ean` er unik, men Shopify stopper ikke to varianter med samme
 * strekkode. Når farger flyttes fra ett produkt til et annet (Finull (2) → Finull, 09.10.2026),
 * står den gamle varianten igjen som utkast med samme EAN, og raden for den i `products` har
 * den fortsatt. Uten dette feilet hele sync-products på den unike nøkkelen.
 *
 * REN logikk, ingen I/O.
 */
export interface EanRow {
  shopify_variant_id: string;
  ean: string | null;
  active: boolean;
}

export interface EanDuplicate {
  ean: string;
  kept: string;
  dropped: string[];
}

/**
 * Deler hver EAN ut til én variant: aktiv vinner over utkast, ellers den som kom først.
 * De andre lagres uten EAN (og matches da aldri på strekkode). Duplikatene returneres så
 * sync-products kan si fra om dem.
 */
export function assignEans<T extends EanRow>(rows: T[]): { rows: T[]; duplicates: EanDuplicate[] } {
  const winner = new Map<string, T>();
  for (const r of rows) {
    if (!r.ean) continue;
    const cur = winner.get(r.ean);
    if (!cur || (r.active && !cur.active)) winner.set(r.ean, r);
  }
  const dropped = new Map<string, string[]>();
  const out = rows.map((r) => {
    if (!r.ean || winner.get(r.ean) === r) return r;
    dropped.set(r.ean, [...(dropped.get(r.ean) ?? []), r.shopify_variant_id]);
    return { ...r, ean: null };
  });
  const duplicates = [...dropped].map(([ean, d]) => ({ ean, kept: winner.get(ean)!.shopify_variant_id, dropped: d }));
  return { rows: out, duplicates };
}

/**
 * Rader i tabellen som har en EAN som nå hører til en annen variant. De må miste den før
 * upserten, ellers stopper den unike nøkkelen den nye eieren.
 */
export function staleEanHolders(
  existing: Array<{ id: string; ean: string | null; shopify_variant_id: string | null }>,
  rows: EanRow[],
): string[] {
  const owner = new Map<string, string>();
  for (const r of rows) if (r.ean) owner.set(r.ean, r.shopify_variant_id);
  return existing.filter((e) => e.ean && owner.has(e.ean) && owner.get(e.ean) !== e.shopify_variant_id).map((e) => e.id);
}
