-- ═══════════════════════════════════════════════════════════════════════════
-- BUG FIX: commit_import never recorded which import created a stock line.
--
-- 0011 added stock_lines.import_id and backfilled existing rows, but
-- commit_import was not updated to populate it. Every stock line created since
-- has import_id = NULL, so revert_import — which deletes by import_id — found
-- nothing and silently did nothing.
--
-- Caught by tests/import-flow.test.ts.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function commit_import(p_import_id uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_lot_id     uuid;
  v_status     import_status;
  v_landed     integer;
  r            record;
  v_product_id uuid;
  v_slug       text;
  v_base       text;
  v_n          integer;
  v_created    integer := 0;
  v_matched    integer := 0;
  v_skipped    integer := 0;
begin
  select lot_id, status into v_lot_id, v_status from imports where id = p_import_id;
  if v_status is null then
    raise exception 'Import % not found', p_import_id;
  end if;
  if v_status <> 'pending' then
    raise exception 'Import % is already %', p_import_id, v_status;
  end if;

  for r in select * from import_rows where import_id = p_import_id order by row_number
  loop
    if r.action = 'skip' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if r.action = 'match' and r.matched_product_id is not null then
      v_product_id := r.matched_product_id;
      v_matched := v_matched + 1;
    else
      v_base := slugify(coalesce(nullif(concat_ws(' ', r.brand, r.model), ' '), r.description));
      if coalesce(v_base, '') = '' then
        v_base := 'item-' || r.row_number || '-' || left(replace(p_import_id::text, '-', ''), 8);
      end if;
      v_slug := v_base;
      v_n := 1;
      while exists (select 1 from products where slug = v_slug) loop
        v_n := v_n + 1;
        v_slug := v_base || '-' || v_n;
      end loop;

      select id into v_product_id from products where item_no is not null and item_no = r.item_no;

      if v_product_id is null then
        insert into products (
          item_no, upc, brand, model, name, slug, category_id,
          condition, msrp_cents, price_cents, status
        ) values (
          r.item_no, r.upc, r.brand, r.model, r.description, v_slug, r.category_id,
          map_condition(r.condition_raw), r.unit_retail_cents,
          suggest_price_cents(r.unit_retail_cents), 'draft'
        )
        returning id into v_product_id;
        v_created := v_created + 1;
      else
        v_matched := v_matched + 1;
      end if;
    end if;

    -- import_id is what makes this undoable. Without it revert_import is a no-op.
    insert into stock_lines (
      product_id, lot_id, import_id, condition, condition_raw, msrp_cents, qty_received
    ) values (
      v_product_id, v_lot_id, p_import_id, map_condition(r.condition_raw), r.condition_raw,
      r.unit_retail_cents, greatest(coalesce(r.qty, 1), 1)
    );
  end loop;

  update imports set status = 'committed' where id = p_import_id;

  select landed_cost_cents into v_landed from lots where id = v_lot_id;
  if coalesce(v_landed, 0) > 0 then
    perform allocate_lot_costs(v_lot_id);
  end if;

  return jsonb_build_object(
    'created', v_created, 'matched', v_matched, 'skipped', v_skipped,
    'allocated', coalesce(v_landed, 0) > 0
  );
end $$;
