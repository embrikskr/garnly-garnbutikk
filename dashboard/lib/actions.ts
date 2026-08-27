"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "./db";

/**
 * Kobler en umatchet kasserad til et Garnly-produkt.
 * Fyller samtidig inn EAN/SKU på produktet hvis det mangler, så neste synk matcher automatisk.
 */
export async function resolveUnmatched(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const productId = String(formData.get("product_id") ?? "");
  if (!id || !productId) return;
  const s = db();
  const { data: row } = await s.from("unmatched_items").select("*").eq("id", id).single();
  const { data: product } = await s.from("products").select("id, ean, sku").eq("id", productId).single();
  if (!row || !product) return;

  const patch: Record<string, string> = {};
  if (!product.ean && row.ean) patch.ean = row.ean;
  if (!product.sku && row.sku) patch.sku = row.sku;
  if (Object.keys(patch).length) {
    const { error } = await s.from("products").update(patch).eq("id", productId);
    if (error) throw new Error("Kunne ikke oppdatere produktet: " + error.message);
  }
  await s.from("unmatched_items").update({ resolved_product_id: productId }).eq("id", id);
  revalidatePath("/umatchet");
  redirect("/umatchet");
}

export async function ignoreUnmatched(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await db().from("unmatched_items").update({ ignored: true }).eq("id", id);
  revalidatePath("/umatchet");
}

/** Trigger en synk for én butikk via Edge Function sync-store. */
export async function triggerSync(formData: FormData) {
  const storeId = String(formData.get("store_id") ?? "");
  if (!storeId) return;
  const base = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) throw new Error("SUPABASE_URL / CRON_SECRET mangler");
  try {
    await fetch(`${base}/functions/v1/sync-store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": secret },
      body: JSON.stringify({ store_id: storeId }),
    });
  } catch (e) {
    console.error("sync-store feilet:", e);
  }
  revalidatePath("/synk");
}
