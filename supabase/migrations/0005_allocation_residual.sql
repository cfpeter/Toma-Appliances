-- ═══════════════════════════════════════════════════════════════════════════
-- Allocation residual + bookkeeping table lockdown
--
-- Splitting a lump sum across N units in integer cents always leaves a
-- remainder (measured: 2¢ across 61 units on a $13,550 truckload). Rather
-- than fudge a unit cost to hide it, the remainder is recorded so reports can
-- reconcile exactly:
--
--     sum(qty × unit_cost) + residual = landed_cost
-- ═══════════════════════════════════════════════════════════════════════════

alter table lots
  add column if not exists allocation_residual_cents integer not null default 0;

comment on column lots.allocation_residual_cents is
  'Cents left over after integer-cent allocation. Keeps lot P&L exact.';

create or replace function allocate_lot_costs(p_lot_id uuid)
returns integer
language plpgsql
security invoker
as $$
declare
  v_landed        bigint;
  v_total_retail  bigint;
  v_total_qty     bigint;
  v_allocated     bigint;
  v_updated       integer := 0;
begin
  select landed_cost_cents into v_landed from lots where id = p_lot_id;
  if v_landed is null then
    raise exception 'Lot % not found', p_lot_id;
  end if;

  select coalesce(sum(sl.qty_received::bigint
                      * coalesce(sl.msrp_cents, p.msrp_cents, 0)), 0),
         coalesce(sum(sl.qty_received), 0)
    into v_total_retail, v_total_qty
  from stock_lines sl
  join products p on p.id = sl.product_id
  where sl.lot_id = p_lot_id;

  if v_total_qty = 0 then
    raise exception 'Lot % has no stock lines to allocate against', p_lot_id;
  end if;

  if v_total_retail > 0 then
    -- Proportional to retail value (the normal path)
    update stock_lines sl
       set unit_cost_cents = round(
             (v_landed::numeric
              * (sl.qty_received::numeric * coalesce(sl.msrp_cents, p.msrp_cents, 0))
              / v_total_retail::numeric) / sl.qty_received::numeric
           )::int
      from products p
     where p.id = sl.product_id
       and sl.lot_id = p_lot_id;
  else
    -- No MSRP anywhere in the lot — fall back to an even split per unit
    update stock_lines
       set unit_cost_cents = round(v_landed::numeric / v_total_qty::numeric)::int
     where lot_id = p_lot_id;
  end if;

  get diagnostics v_updated = row_count;

  select coalesce(sum(qty_received::bigint * unit_cost_cents), 0)
    into v_allocated
  from stock_lines where lot_id = p_lot_id;

  update lots
     set costs_allocated_at        = now(),
         allocation_residual_cents = (v_landed - v_allocated)::int
   where id = p_lot_id;

  return v_updated;
end $$;

-- Migration bookkeeping is internal. No public access, ever.
do $$
begin
  if exists (select 1 from pg_class
             where relname = '_migrations' and relnamespace = 'public'::regnamespace) then
    execute 'alter table _migrations enable row level security';
    execute 'revoke all on _migrations from anon';
  end if;
end $$;
