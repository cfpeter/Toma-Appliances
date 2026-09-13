-- ═══════════════════════════════════════════════════════════════════════════
-- Toma Appliances — core schema
--
-- Conventions (see docs/TECHNICAL_PLAN.md §5):
--   * ALL money is INTEGER CENTS. Never float, never numeric-guessing.
--   * Quantity is DERIVED (see 0002_views.sql), never stored.
--   * Nothing is hard-deleted; products carry status = 'deleted'.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Enums ──────────────────────────────────────────────────────────────────

create type product_status as enum ('draft', 'active', 'sold', 'hidden', 'deleted');

-- Private to the owner. Never rendered publicly, never filterable.
create type item_condition as enum ('new', 'open_box', 'scratch_dent', 'used', 'for_parts');

create type import_action as enum ('new', 'match', 'skip');
create type import_status as enum ('pending', 'committed', 'discarded');

-- ── Users ──────────────────────────────────────────────────────────────────
-- Mirrors auth.users. One role today (everyone full-access); the column exists
-- so a restricted tier can be added later without a migration.

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text        not null,
  full_name   text,
  role        text        not null default 'owner',
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- ── Sources ────────────────────────────────────────────────────────────────
-- Where inventory comes from. Each B-Stock marketplace uses its own category
-- names and its own item-description conventions, so parsing and category
-- mapping are configured PER SOURCE.

create table sources (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,          -- 'bstock_costco'
  name          text        not null,          -- 'Costco Liquidation (B-Stock)'
  is_active     boolean     not null default true,
  -- How to turn "SS WF45T6000AW 4.5CUFT" into a model number + readable name.
  -- Per-source because Samsung, Costco and Walmart all write descriptions
  -- differently. Empty = fall back to the generic parser.
  parse_rules   jsonb       not null default '{}'::jsonb,
  notes         text,
  created_at    timestamptz not null default now()
);

-- ── Categories ─────────────────────────────────────────────────────────────
-- Self-referencing tree: Laundry → Washers. Public-facing taxonomy, ours, not
-- the seller's.

create table categories (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references categories(id) on delete restrict,
  name        text        not null,
  slug        text        not null,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  unique (parent_id, slug)
);
create index categories_parent_idx on categories(parent_id);
-- Postgres treats NULLs as distinct, so the unique(parent_id, slug) constraint
-- above does not stop duplicate TOP-LEVEL categories. This does.
create unique index categories_root_slug_key on categories(slug) where parent_id is null;

-- ── Lots ───────────────────────────────────────────────────────────────────
-- One auction purchase. The manifest never says what you paid — the winning
-- bid, buyer premium and freight are entered by hand, then allocated across
-- units in proportion to retail value.

create table lots (
  id                  uuid primary key default gen_random_uuid(),
  source_id           uuid references sources(id) on delete restrict,
  lot_code            text,                     -- 'ONT-6954689'
  vendor              text,                     -- 'SAMSUNG ELECTRONICS AMERI'
  purchase_date       date,
  bid_cents           integer not null default 0 check (bid_cents        >= 0),
  premium_cents       integer not null default 0 check (premium_cents    >= 0),
  freight_cents       integer not null default 0 check (freight_cents    >= 0),
  other_cost_cents    integer not null default 0 check (other_cost_cents >= 0),
  landed_cost_cents   integer generated always as
                        (bid_cents + premium_cents + freight_cents + other_cost_cents) stored,
  costs_allocated_at  timestamptz,              -- set once allocation has run
  notes               text,
  created_at          timestamptz not null default now(),
  created_by          uuid references profiles(id)
);
create index lots_source_idx on lots(source_id);

-- ── Products ───────────────────────────────────────────────────────────────
-- A MODEL with a quantity, not an individual unit. Four identical dryers are
-- one product with qty 4.

create table products (
  id            uuid primary key default gen_random_uuid(),
  item_no        text,                          -- B-Stock 'Item #' — the match key
  upc            text,
  brand          text,
  model          text,
  name           text        not null,          -- customer-facing
  slug           text unique not null,
  description    text,
  category_id    uuid references categories(id) on delete restrict,
  condition      item_condition,                -- 🔒 private
  msrp_cents     integer check (msrp_cents  >= 0),   -- 🔒 private ('Unit Retail')
  price_cents    integer check (price_cents >= 0),   -- 🌐 public — what you charge
  status         product_status not null default 'draft',
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references profiles(id)
);

-- item_no is the dedupe key: the same model bought on a later truckload
-- carries the same Item # and merges into the existing product.
create unique index products_item_no_key on products(item_no) where item_no is not null;
create index products_status_idx   on products(status);
create index products_category_idx on products(category_id);
create index products_brand_idx    on products(brand);

-- ── Photos ─────────────────────────────────────────────────────────────────

create table product_photos (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  r2_key      text not null,
  sort_order  integer not null default 0,
  alt_text    text,
  width       integer,
  height      integer,
  bytes       integer,
  created_at  timestamptz not null default now()
);
create index product_photos_product_idx on product_photos(product_id, sort_order);

-- ── Stock lines ────────────────────────────────────────────────────────────
-- The private layer beneath each product: condition, how many, what they cost,
-- which lot they came from. One product can have several (2 open-box from one
-- truckload, 3 scratch & dent from another).

create table stock_lines (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references products(id) on delete cascade,
  lot_id           uuid references lots(id) on delete restrict,
  condition        item_condition,
  -- Exactly as the manifest wrote it ('USED', 'USED_FAIR'). Preserved because
  -- B-Stock's condition vocabulary is richer than our enum.
  condition_raw    text,
  -- 'Unit Retail' FROM THIS LOT. The same Item # genuinely carries different
  -- MSRPs in different manifests (verified across both sample files), so
  -- allocation must use the lot's own figure, not the product's latest.
  msrp_cents       integer check (msrp_cents >= 0),
  qty_received     integer not null check (qty_received > 0),
  -- Frozen at allocation time. Later MSRP edits must NOT silently rewrite the
  -- cost of goods already sold.
  unit_cost_cents  integer check (unit_cost_cents >= 0),
  created_at       timestamptz not null default now()
);
create index stock_lines_product_idx on stock_lines(product_id);
create index stock_lines_lot_idx     on stock_lines(lot_id);

-- ── Sales ──────────────────────────────────────────────────────────────────
-- Quantity and price only. No customer name, no phone — storing personal data
-- creates obligations the business doesn't want.

create table sales (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references products(id) on delete restrict,
  stock_line_id    uuid references stock_lines(id) on delete set null,
  qty              integer not null check (qty > 0),
  sale_price_cents integer not null check (sale_price_cents >= 0),
  sold_at          timestamptz not null default now(),
  note             text,
  created_by       uuid references profiles(id)
);
create index sales_product_idx on sales(product_id);
create index sales_sold_at_idx on sales(sold_at);

-- ── Imports ────────────────────────────────────────────────────────────────

create table imports (
  id           uuid primary key default gen_random_uuid(),
  lot_id       uuid references lots(id) on delete set null,
  source_id    uuid references sources(id) on delete restrict,
  filename     text,
  row_count    integer not null default 0,
  status       import_status not null default 'pending',
  imported_at  timestamptz not null default now(),
  imported_by  uuid references profiles(id)
);

-- Every CSV row, stored raw and permanently. If the manifest carries 30 fields
-- and we display 8, the other 22 are still here. Nothing ever needs re-importing.
create table import_rows (
  id                     uuid primary key default gen_random_uuid(),
  import_id              uuid not null references imports(id) on delete cascade,
  row_number             integer not null,
  raw                    jsonb   not null,      -- the ENTIRE original row
  -- Parsed/cleaned projections used by the review screen:
  item_no                text,
  upc                    text,
  brand                  text,
  model                  text,
  description            text,
  qty                    integer,
  unit_retail_cents      integer,
  source_category        text,                  -- 'LAUNDRY_APPLIANCES'
  source_seller_category text,                  -- 'Washers'
  condition_raw          text,
  action                 import_action,
  matched_product_id     uuid references products(id) on delete set null,
  flags                  jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  unique (import_id, row_number)
);
create index import_rows_import_idx  on import_rows(import_id);
create index import_rows_item_no_idx on import_rows(item_no);

-- ── Category mapping ───────────────────────────────────────────────────────
-- Seller taxonomy → ours. Keyed BY SOURCE because Costco's "Appliances" and
-- Samsung's "Appliances" are different things and must not collide.

create table category_map (
  id                     uuid primary key default gen_random_uuid(),
  source_id              uuid references sources(id) on delete cascade,
  source_category        text,
  source_seller_category text,
  category_id            uuid not null references categories(id) on delete restrict,
  created_at             timestamptz not null default now(),
  unique (source_id, source_category, source_seller_category)
);
-- source_id NULL = applies to every source. Postgres treats NULLs as distinct,
-- so the constraint above would not stop duplicate global rows. This does.
create unique index category_map_global_key
  on category_map(source_category, source_seller_category)
  where source_id is null;

-- ── Settings ───────────────────────────────────────────────────────────────
-- Markup rules, business hours, contact details, page copy.

create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ── updated_at trigger ─────────────────────────────────────────────────────

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger products_updated_at
  before update on products
  for each row execute function set_updated_at();
