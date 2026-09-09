-- Alias: kobler et produkt i ett kassesystem (uten brukbar EAN) til et Garnly-produkt.
-- external_id er kassesystemets egen nøkkel: Duell product_number, Mystore "v:<variant-id>" / "p:<product-id>".
-- Matching i sync-store: 1) EAN, 2) alias, 3) SKU, 4) navn.
create table product_aliases (
  store_id     uuid not null references stores(id) on delete cascade,
  external_id  text not null,
  product_id   uuid not null references products(id) on delete cascade,
  note         text,
  created_at   timestamptz not null default now(),
  primary key (store_id, external_id)
);
create index product_aliases_product_idx on product_aliases (product_id);
alter table product_aliases enable row level security;
