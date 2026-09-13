-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
--
-- Two layers, both enforced by Postgres rather than by application code:
--   1. RLS policies  — which ROWS you can see
--   2. Column GRANTs — which COLUMNS you can see
--
-- The second matters here: cost, MSRP and condition live on the products table
-- alongside public fields. RLS alone cannot hide a column, so the anon role is
-- granted access to public columns only. A bug in the site code cannot leak
-- margins, because the database will not return them.
-- ═══════════════════════════════════════════════════════════════════════════

alter table profiles       enable row level security;
alter table sources        enable row level security;
alter table categories     enable row level security;
alter table lots           enable row level security;
alter table products       enable row level security;
alter table product_photos enable row level security;
alter table stock_lines    enable row level security;
alter table sales          enable row level security;
alter table imports        enable row level security;
alter table import_rows    enable row level security;
alter table category_map   enable row level security;
alter table settings       enable row level security;

-- ── Signed-in users: full access ───────────────────────────────────────────
-- One role today. The `role` column on profiles exists so a restricted tier
-- can be introduced later without restructuring.

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','sources','categories','lots','products','product_photos',
    'stock_lines','sales','imports','import_rows','category_map','settings'
  ] loop
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t
    );
  end loop;
end $$;

-- ── Public: read-only, and only what customers should see ──────────────────

-- Live and sold products (sold ones keep their SOLD badge and their Google
-- ranking). Drafts, hidden and deleted products are invisible.
create policy products_public_read on products
  for select to anon
  using (status in ('active', 'sold'));

create policy product_photos_public_read on product_photos
  for select to anon
  using (exists (
    select 1 from products p
    where p.id = product_photos.product_id
      and p.status in ('active', 'sold')
  ));

create policy categories_public_read on categories
  for select to anon
  using (is_active);

-- ── Column-level grants ────────────────────────────────────────────────────

revoke all on products       from anon;
revoke all on product_photos from anon;
revoke all on categories     from anon;

-- Public product columns ONLY.
-- Deliberately excluded: item_no (B-Stock sourcing), msrp_cents, condition,
-- created_by, updated_at.
grant select (
  id, upc, brand, model, name, slug, description,
  category_id, price_cents, status, published_at, created_at
) on products to anon;

grant select (id, product_id, r2_key, sort_order, alt_text, width, height)
  on product_photos to anon;

grant select (id, parent_id, name, slug, sort_order, is_active)
  on categories to anon;

-- Everything else is invisible to the public: costs, lots, sales, imports,
-- stock lines, settings, user accounts. No policy granted = no access.

grant select on product_stock to anon;
grant select on catalog       to anon;
