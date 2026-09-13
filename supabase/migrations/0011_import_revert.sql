-- ═══════════════════════════════════════════════════════════════════════════
-- Deleting and undoing imports
--
-- A pending import is just staging — deleting it is harmless.
--
-- A COMMITTED import has created real products and stock. Undoing it must not
-- destroy anything the business depends on, so revert_import:
--   * removes only the stock lines that this import created
--   * removes products left with no stock AND no sales
--   * KEEPS any product that has been sold, or that also holds stock from
--     another lot
--   * puts the import back to 'pending' so it can be reviewed again
-- ═══════════════════════════════════════════════════════════════════════════

-- Stock lines didn't record which import created them, so a revert had no way
-- to be precise. They do now.
alter table stock_lines
  add column if not exists import_id uuid references imports(id) on delete set null;

create index if not exists stock_lines_import_idx on stock_lines(import_id);

-- Backfill: for lots with exactly one import, the attribution is unambiguous.
update stock_lines sl
   set import_id = i.id
  from imports i
 where sl.import_id is null
   and i.lot_id = sl.lot_id
   and (select count(*) from imports i2 where i2.lot_id = sl.lot_id) = 1;

create or replace function revert_import(p_import_id uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_lot_id          uuid;
  v_removed_stock   integer := 0;
  v_removed_product integer := 0;
  v_kept_sold       integer := 0;
begin
  select lot_id into v_lot_id from imports where id = p_import_id;
  if not found then
    raise exception 'Import % not found', p_import_id;
  end if;

  -- Products that have been sold are never touched.
  select count(distinct sl.product_id) into v_kept_sold
    from stock_lines sl
   where sl.import_id = p_import_id
     and exists (select 1 from sales s where s.product_id = sl.product_id);

  with gone as (
    delete from stock_lines
     where import_id = p_import_id
       and product_id not in (select product_id from sales)
    returning product_id
  )
  select count(*) into v_removed_stock from gone;

  -- Sweep up products this left empty: no stock anywhere, never sold.
  with orphans as (
    delete from products p
     where not exists (select 1 from stock_lines sl where sl.product_id = p.id)
       and not exists (select 1 from sales s where s.product_id = p.id)
    returning p.id
  )
  select count(*) into v_removed_product from orphans;

  update imports set status = 'pending' where id = p_import_id;

  -- Costs were allocated over a set of units that no longer exists.
  update lots set costs_allocated_at = null, allocation_residual_cents = 0
   where id = v_lot_id;

  return jsonb_build_object(
    'stock_lines_removed', v_removed_stock,
    'products_removed', v_removed_product,
    'products_kept_because_sold', v_kept_sold
  );
end $$;
