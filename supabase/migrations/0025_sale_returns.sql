-- ═══════════════════════════════════════════════════════════════════════════
-- A sale can come back
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two different things that look alike from the outside:
--
--   * a mistake -- the wrong unit, a mistyped price, a sale that never
--     happened. That row should go, because it describes nothing real.
--
--   * a return -- the customer bought it and brought it back. That happened.
--     Deleting it would make the month read as though the sale never
--     occurred, when what actually occurred is a sale and a refund.
--
-- Deleting handles the first and needs no schema. This is the second: the row
-- stays, stamped with when it came back, and stops counting toward stock or
-- revenue from that moment.

alter table sales
  add column if not exists returned_at timestamptz,
  add column if not exists return_note text;

comment on column sales.returned_at is
  'Set when the customer brought it back. The row stays: it describes a real
   sale that was later refunded, which is not the same as a sale that never
   happened.';

create index if not exists sales_returned_idx on sales(returned_at) where returned_at is null;

-- ── Stock again ────────────────────────────────────────────────────────────
-- Quantity is derived, so a returned unit is back on the floor the moment the
-- row is stamped -- nothing to remember to adjust.

create or replace view product_stock
with (security_invoker = true) as
select
  p.id as product_id,
  coalesce(sl.qty_received, 0)                         as qty_received,
  coalesce(sa.qty_sold, 0)                             as qty_sold,
  coalesce(sl.qty_received, 0) - coalesce(sa.qty_sold, 0) as qty_available
from products p
left join (
  select product_id, sum(qty_received)::int as qty_received
  from stock_lines group by product_id
) sl on sl.product_id = p.id
left join (
  select product_id, sum(qty)::int as qty_sold
  from sales where returned_at is null group by product_id
) sa on sa.product_id = p.id;

-- The public catalogue computes its own totals (see 0017) and needs the same
-- correction, or a returned unit stays invisible to customers.
create or replace view catalog
with (security_invoker = false) as
select
  p.id, p.upc, p.brand, p.model, p.name, p.slug, p.description,
  p.category_id, p.price_cents, p.condition, p.status, p.published_at, p.created_at,
  coalesce(sl.qty_received, 0) - coalesce(sa.qty_sold, 0) as qty_available
from products p
left join (
  select product_id, sum(qty_received)::int as qty_received
  from stock_lines group by product_id
) sl on sl.product_id = p.id
left join (
  select product_id, sum(qty)::int as qty_sold
  from sales where returned_at is null group by product_id
) sa on sa.product_id = p.id
where p.status in ('active', 'sold');

grant select on catalog to anon, authenticated;

-- ── The ledger ─────────────────────────────────────────────────────────────
-- A returned sale keeps its page in the history and contributes nothing to
-- the totals. Showing it as a row of zeroes is the honest version: it did
-- happen, and it earned nothing.

-- Dropped rather than replaced: `create or replace view` cannot insert a
-- column into the middle of the list, and the new ones belong next to the
-- sale they describe rather than tacked on the end.
drop view if exists sales_ledger;

create view sales_ledger
with (security_invoker = true) as
select
  s.id,
  s.sold_at,
  s.qty,
  s.note,
  s.returned_at,
  s.return_note,
  s.product_id,
  p.name,
  p.brand,
  p.model,
  p.condition,
  p.status                                             as product_status,
  s.list_price_cents,
  s.sale_price_cents,
  s.unit_cost_cents,
  case when s.returned_at is null
       then s.list_price_cents - s.sale_price_cents end as discount_cents,
  case when s.returned_at is null
       then s.sale_price_cents * s.qty else 0 end       as revenue_cents,
  case when s.returned_at is null
       then (s.sale_price_cents - s.unit_cost_cents) * s.qty else 0 end as margin_cents
from sales s
join products p on p.id = s.product_id;

grant select on sales_ledger to authenticated;

-- ── Marking one returned ───────────────────────────────────────────────────
-- A function rather than a bare update so the status trigger fires and the
-- listing comes back on its own.

create or replace function return_sale(p_sale_id uuid, p_note text default null)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_sale sales;
begin
  select * into v_sale from sales where id = p_sale_id;
  if not found then
    raise exception 'Sale % not found', p_sale_id;
  end if;
  if v_sale.returned_at is not null then
    raise exception 'That sale is already marked returned.';
  end if;

  update sales
     set returned_at = now(),
         return_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_sale_id;

  -- sync_product_status watches sales, so the product flips back to active
  -- by itself once the unit is available again.
  return jsonb_build_object(
    'qty', v_sale.qty,
    'refunded_cents', v_sale.sale_price_cents * v_sale.qty
  );
end $$;

revoke execute on function return_sale(uuid, text) from public, anon;
grant execute on function return_sale(uuid, text) to authenticated;
