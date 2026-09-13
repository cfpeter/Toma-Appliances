-- ═══════════════════════════════════════════════════════════════════════════
-- You cannot sell what you do not have
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Quantity is derived -- qty_received minus qty_sold -- so nothing stopped it
-- going negative. Selling 5 of a product with 1 in stock was accepted and
-- left qty_available at -4, which then flows into the public catalog and
-- every total on the sales page.
--
-- The form carried `max={qty_available}`, but that is an HTML attribute: it
-- does not survive a double-click on "Mark sold", two people recording the
-- same sale, or anything that is not the browser form.
--
-- Checked after the row lands, because the quantity is only knowable once the
-- sale is part of the sum. A raise here rolls the whole statement back.

create or replace function guard_stock_not_negative()
returns trigger
language plpgsql
security invoker
as $$
declare
  v_product uuid := coalesce(new.product_id, old.product_id);
  v_avail   integer;
  v_name    text;
begin
  select qty_available into v_avail from product_stock where product_id = v_product;

  if v_avail < 0 then
    select name into v_name from products where id = v_product;
    raise exception
      'Not enough stock for "%": that would leave % units.', v_name, v_avail
      using errcode = 'check_violation',
            hint    = 'Record a smaller quantity, or add the stock first.';
  end if;

  return null;
end $$;

-- Fires before sales_sync_status by name, though either order is fine: the
-- exception rolls back the whole statement regardless.
drop trigger if exists sales_guard_stock on sales;
create trigger sales_guard_stock
  after insert or update on sales
  for each row execute function guard_stock_not_negative();
