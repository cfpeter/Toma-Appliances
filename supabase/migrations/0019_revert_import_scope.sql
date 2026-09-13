-- ═══════════════════════════════════════════════════════════════════════════
-- revert_import: only clean up what this import actually created
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The orphan sweep was unscoped:
--
--     delete from products p
--      where not exists (select 1 from stock_lines sl where sl.product_id = p.id)
--        and not exists (select 1 from sales s where s.product_id = p.id)
--
-- No mention of the import. Undoing one import therefore hard-deleted every
-- product anywhere in the database that happened to hold no stock and no
-- sales -- a product typed in by hand before its lot arrived, or one left
-- stockless by an earlier revert. The header of 0011 promised this function
-- "removes only the stock lines that this import created"; the products half
-- never honoured that.
--
-- The ids have to be carried across statements in a variable rather than
-- chained through CTEs: CTEs in a single statement all see the same snapshot,
-- so the orphan check would not observe the stock lines deleted beside it.

create or replace function revert_import(p_import_id uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_lot_id          uuid;
  v_touched         uuid[];
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
  select coalesce(array_agg(distinct product_id), '{}'::uuid[]), count(*)
    into v_touched, v_removed_stock
    from gone;

  -- Separate statement, so the deletes above are visible to this check.
  -- Scoped to the products this import touched: a product that still holds
  -- stock from another lot, or that has ever sold, stays.
  with orphans as (
    delete from products p
     where p.id = any (v_touched)
       and not exists (select 1 from stock_lines sl where sl.product_id = p.id)
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
