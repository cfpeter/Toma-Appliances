-- ═══════════════════════════════════════════════════════════════════════════
-- Deleting a lot
--
-- The most destructive action in the system: a lot sits underneath stock
-- lines, which sit underneath products. Unwinding it must not take out
-- anything that is still in use.
--
-- Two rules:
--   1. If ANY unit from the lot has been sold, deletion is refused. Removing
--      it would erase real revenue and silently rewrite past profit. Archive
--      the lot instead.
--   2. A product is removed only if it has no stock left from ANY other lot
--      and has never been sold. Products shared across truckloads survive
--      with their quantity reduced.
-- ═══════════════════════════════════════════════════════════════════════════

alter table lots
  add column if not exists archived_at timestamptz;

comment on column lots.archived_at is
  'Set instead of deleting when the lot has sales. Hidden from the list, history intact.';

/** What deleting this lot would do. Drives the confirmation dialog. */
create or replace function lot_delete_preview(p_lot_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'units', (
      select coalesce(sum(sl.qty_received), 0)::int
        from stock_lines sl where sl.lot_id = p_lot_id),
    'products_removed', (
      select count(*)::int from products p
       where exists (select 1 from stock_lines sl
                      where sl.product_id = p.id and sl.lot_id = p_lot_id)
         and not exists (select 1 from stock_lines s2
                          where s2.product_id = p.id and s2.lot_id is distinct from p_lot_id)
         and not exists (select 1 from sales s where s.product_id = p.id)),
    'products_kept', (
      select count(*)::int from products p
       where exists (select 1 from stock_lines sl
                      where sl.product_id = p.id and sl.lot_id = p_lot_id)
         and (exists (select 1 from stock_lines s2
                       where s2.product_id = p.id and s2.lot_id is distinct from p_lot_id)
              or exists (select 1 from sales s where s.product_id = p.id))),
    'sales', (
      select count(*)::int from sales s
       where exists (select 1 from stock_lines sl
                      where sl.product_id = s.product_id and sl.lot_id = p_lot_id)),
    'imports', (select count(*)::int from imports i where i.lot_id = p_lot_id)
  )
$$;

create or replace function delete_lot(p_lot_id uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_code            text;
  v_sales           integer;
  v_units           integer := 0;
  v_products        integer := 0;
begin
  select lot_code into v_code from lots where id = p_lot_id;
  if v_code is null then
    raise exception 'Lot % not found', p_lot_id;
  end if;

  -- Rule 1: never destroy revenue.
  select count(*) into v_sales
    from sales s
   where exists (select 1 from stock_lines sl
                  where sl.product_id = s.product_id and sl.lot_id = p_lot_id);
  if v_sales > 0 then
    raise exception
      'Lot % has % sale(s) against it. Archive it instead of deleting — removing it would erase revenue you have already earned.',
      v_code, v_sales
      using errcode = 'restrict_violation';
  end if;

  select coalesce(sum(qty_received), 0)::int into v_units
    from stock_lines where lot_id = p_lot_id;

  delete from stock_lines where lot_id = p_lot_id;

  -- Rule 2: only genuine orphans. Anything still stocked from another lot,
  -- or ever sold, stays.
  with gone as (
    delete from products p
     where not exists (select 1 from stock_lines sl where sl.product_id = p.id)
       and not exists (select 1 from sales s where s.product_id = p.id)
    returning p.id
  )
  select count(*)::int into v_products from gone;

  delete from imports where lot_id = p_lot_id;  -- import_rows cascade
  delete from lots where id = p_lot_id;

  return jsonb_build_object(
    'lot_code', v_code,
    'units_removed', v_units,
    'products_removed', v_products
  );
end $$;

create or replace function archive_lot(p_lot_id uuid, p_archived boolean default true)
returns void
language sql
security invoker
as $$
  update lots set archived_at = case when p_archived then now() else null end
   where id = p_lot_id
$$;
