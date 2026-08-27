export type PosSystem = "duell" | "mystore" | "csv" | "manual";

export interface StoreRow {
  id: string;
  name: string;
  slug: string;
  pos_system: PosSystem;
  pos_config: Record<string, unknown>;
  shopify_location_id: string | null;
  shipping_sender_id: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notify_channel: "email" | "sms" | "both";
  business_hours: Record<string, [string, string] | null>;
  offer_ttl_hours: number;
  safety_stock: number;
  auto_accept: boolean;
  last_assigned_at: string | null;
  assigned_count: number;
  timeout_streak: number;
  weight: number;
  active: boolean;
  last_sync_at: string | null;
  last_sync_status: string | null;
  consecutive_sync_failures: number;
}

export interface ProductRow {
  id: string;
  ean: string | null;
  sku: string | null;
  name: string;
  brand: string | null;
  yarn_name: string | null;
  color_code: string | null;
  color_name: string | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_inventory_item_id: string | null;
  active: boolean;
}

/** Én lagerrad fra et kassesystem. Adapteren normaliserer alt til dette. */
export interface StockLine {
  ean: string | null;
  sku: string | null;
  name: string | null;
  qty: number;
}

export interface LineItem {
  line_item_id: string;
  variant_id: string;
  product_id: string; // Garnly products.id
  qty: number;
  title: string;
}

export interface RoutingGroupRow {
  id: string;
  routing_order_id: string;
  group_no: number;
  line_items: LineItem[];
  shopify_fulfillment_order_id: string | null;
  status: "routing" | "assigned" | "escalated" | "cancelled";
  assigned_store_id: string | null;
}

export interface OfferRow {
  id: string;
  routing_group_id: string;
  store_id: string;
  sequence_no: number;
  status: "pending" | "offered" | "accepted" | "declined" | "declined_stock" | "expired" | "cancelled";
  token_hash: string | null;
  offered_at: string | null;
  deadline_at: string | null;
}
