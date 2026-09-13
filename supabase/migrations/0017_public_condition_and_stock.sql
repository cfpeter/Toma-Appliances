-- ═══════════════════════════════════════════════════════════════════════════
-- Public catalog: real stock counts, and condition on show
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two changes, both driven by what the public listing has to say:
--
--   1. Quantity was always 0 for the public. `product_stock` is
--      security_invoker, so it recomputed under the caller's permissions --
--      and `anon` has no policy on stock_lines or sales, so both sides of the
--      join came back empty and every count collapsed to zero. Verified: the
--      owner saw 4 of a refrigerator, anon saw 0.
--
--   2. Condition was deliberately private. It no longer is: a liquidation
--      buyer's first question is what shape the thing is in, and hiding it
--      only produces a phone call that ends in disappointment.
--
-- `catalog` becomes the single public surface and runs as its own owner, so
-- the WHERE clause below -- not the caller's RLS -- is the gate. That is the
-- point: it exposes exactly these columns, for exactly these statuses, and
-- anon loses direct reach into the stock tables entirely.

drop view if exists catalog;

create view catalog
with (security_invoker = false) as
select
  p.id,
  p.upc,
  p.brand,
  p.model,
  p.name,
  p.slug,
  p.description,
  p.category_id,
  p.price_cents,
  p.condition,
  p.status,
  p.published_at,
  p.created_at,
  -- Derived here rather than joined from product_stock so this view stands
  -- alone. Mixing a definer view over an invoker one makes the effective
  -- permissions genuinely hard to reason about.
  coalesce(sl.qty_received, 0) - coalesce(sa.qty_sold, 0) as qty_available
from products p
left join (
  select product_id, sum(qty_received)::int as qty_received
  from stock_lines group by product_id
) sl on sl.product_id = p.id
left join (
  select product_id, sum(qty)::int as qty_sold
  from sales group by product_id
) sa on sa.product_id = p.id
where p.status in ('active', 'sold');

grant select on catalog to anon, authenticated;

-- Still cost, MSRP, item_no and every unpublished row are out of reach: the
-- view never selects them. product_stock stays invoker-only for the admin,
-- where it returns honest numbers.
revoke all on product_stock from anon;

-- Condition is public now. Kept as a column grant too, so a page that reads
-- `products` directly rather than `catalog` behaves the same way.
grant select (condition) on products to anon;
