-- ═══════════════════════════════════════════════════════════════════════════
-- Sales: remember what you were asking, not just what you got
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Prices are negotiated at the door, so the listed price and the sale price
-- are different numbers and both matter. Until now `sales` recorded only
-- `sale_price_cents`. The asking price lived on `products.price_cents` -- a
-- column that moves: repriced next week, and last month's $739 listing looks
-- like it was always $650. The discount became unknowable after the fact.
--
-- Cost has the same problem from the other side: `stock_lines.unit_cost_cents`
-- is rewritten whenever a lot's costs are re-allocated, so margin computed by
-- joining live cost drifts away from what the sale actually earned.
--
-- Both are therefore snapshotted onto the sale row at the moment it happens.
-- A sale becomes an immutable record of that transaction.

alter table sales
  add column if not exists list_price_cents integer check (list_price_cents >= 0),
  add column if not exists unit_cost_cents  integer check (unit_cost_cents  >= 0);

comment on column sales.list_price_cents is
  'Asking price at the moment of sale. Snapshotted -- never read live from products.';
comment on column sales.unit_cost_cents is
  'Allocated landed cost per unit at the moment of sale. Snapshotted.';

-- Filled by trigger rather than by the app, so every path gets it: the admin
-- form, a script, a hand-written insert. Passing a value explicitly still
-- wins, which is what lets a correction be entered after the fact.

create or replace function snapshot_sale_prices()
returns trigger
language plpgsql
security invoker
as $$
begin
  if new.list_price_cents is null then
    select price_cents into new.list_price_cents
      from products where id = new.product_id;
  end if;

  if new.unit_cost_cents is null then
    if new.stock_line_id is not null then
      select unit_cost_cents into new.unit_cost_cents
        from stock_lines where id = new.stock_line_id;
    else
      -- Units from several lots cost different amounts and the form does not
      -- ask which one walked out of the door. Weighted average is the honest
      -- answer to a question nobody can answer exactly.
      select round(
               sum(unit_cost_cents::numeric * qty_received)
               / nullif(sum(qty_received), 0)
             )::int
        into new.unit_cost_cents
        from stock_lines
       where product_id = new.product_id
         and unit_cost_cents is not null;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists sales_snapshot on sales;
create trigger sales_snapshot
  before insert on sales
  for each row execute function snapshot_sale_prices();

-- Existing rows predate the snapshot. Current price is the best estimate
-- available, and being explicit beats leaving them null and unexplained.
update sales s
   set list_price_cents = p.price_cents
  from products p
 where s.product_id = p.id
   and s.list_price_cents is null;

-- ── What sold, for how much, and how far off the asking price ──────────────
-- Everything a sales report needs, with the arithmetic done once here rather
-- than repeated in each page. Negative discount = sold ABOVE the asking price.

create or replace view sales_ledger
with (security_invoker = true) as
select
  s.id,
  s.sold_at,
  s.qty,
  s.note,
  s.product_id,
  p.name,
  p.brand,
  p.model,
  p.condition,
  p.status                                             as product_status,
  s.list_price_cents,
  s.sale_price_cents,
  s.unit_cost_cents,
  s.list_price_cents - s.sale_price_cents              as discount_cents,
  s.sale_price_cents * s.qty                           as revenue_cents,
  (s.sale_price_cents - s.unit_cost_cents) * s.qty     as margin_cents
from sales s
join products p on p.id = s.product_id;

grant select on sales_ledger to authenticated;
