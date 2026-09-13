-- ═══════════════════════════════════════════════════════════════════════════
-- Escape hatch for deleting a lot that has sales against it.
--
-- The default stays protective: deleting a lot with recorded sales is refused,
-- because in normal use that erases real revenue. But a lot entered by mistake
-- — or created while testing — must not become permanently undeletable, so an
-- explicit force flag is available. The UI asks for it separately and spells
-- out exactly what will be destroyed.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function delete_lot(p_lot_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_code     text;
  v_sales    integer;
  v_units    integer := 0;
  v_products integer := 0;
begin
  select lot_code into v_code from lots where id = p_lot_id;
  if v_code is null then
    raise exception 'Lot % not found', p_lot_id;
  end if;

  select count(*) into v_sales
    from sales s
   where exists (select 1 from stock_lines sl
                  where sl.product_id = s.product_id and sl.lot_id = p_lot_id);

  if v_sales > 0 and not p_force then
    raise exception
      'Lot % has % sale(s) against it. Archive it, or delete with force if it was entered by mistake.',
      v_code, v_sales
      using errcode = 'restrict_violation';
  end if;

  select coalesce(sum(qty_received), 0)::int into v_units
    from stock_lines where lot_id = p_lot_id;

  -- Forced: the sales belong to stock that is about to stop existing, so they
  -- go too. Only sales whose product has NO stock from any other lot.
  if p_force and v_sales > 0 then
    delete from sales s
     where exists (select 1 from stock_lines sl
                    where sl.product_id = s.product_id and sl.lot_id = p_lot_id)
       and not exists (select 1 from stock_lines s2
                        where s2.product_id = s.product_id
                          and s2.lot_id is distinct from p_lot_id);
  end if;

  delete from stock_lines where lot_id = p_lot_id;

  with gone as (
    delete from products p
     where not exists (select 1 from stock_lines sl where sl.product_id = p.id)
       and not exists (select 1 from sales s where s.product_id = p.id)
    returning p.id
  )
  select count(*)::int into v_products from gone;

  delete from imports where lot_id = p_lot_id;
  delete from lots where id = p_lot_id;

  return jsonb_build_object(
    'lot_code', v_code,
    'units_removed', v_units,
    'products_removed', v_products,
    'sales_removed', case when p_force then v_sales else 0 end
  );
end $$;
