-- ═══════════════════════════════════════════════════════════════════════════
-- Fix the suggested-price rounding, and raise the default markup.
--
-- BUG: the rounding floored to the nearest $100 before adding the ending, so
-- a $719.99 MSRP at 35% produced $209.00 instead of ~$249. It quietly threw
-- away up to $99 of price on every single item.
--
-- Correct behaviour: round down to the nearest $10, then end in 9
--   $251.99 → $249.00      $1,049.99 → $1,039.00
--
-- The default percentage also moves 35% → 45%. At 35%, a washer costing
-- $181 would have been suggested at $209 — a $28 margin. Used appliances of
-- this kind resell around half of MSRP.
-- ═══════════════════════════════════════════════════════════════════════════

update settings
   set value = jsonb_set(
         jsonb_set(value, '{msrp_percent}', '0.45'::jsonb),
         '{round_to_cents}', '100'::jsonb),
       updated_at = now()
 where key = 'pricing';

create or replace function suggest_price_cents(p_msrp_cents integer)
returns integer
language plpgsql
stable
as $$
declare
  v_pricing jsonb;
  v_pct     numeric;
  v_raw     numeric;
begin
  if p_msrp_cents is null or p_msrp_cents <= 0 then return null; end if;

  select value into v_pricing from settings where key = 'pricing';
  v_pct := coalesce((v_pricing ->> 'msrp_percent')::numeric, 0.45);
  v_raw := p_msrp_cents * v_pct;

  -- Down to the nearest $10, then end in 9 → $249.00, $1,039.00
  return greatest((floor(v_raw / 1000) * 1000 - 100)::int, 1900);
end $$;

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
      -- Slugs are frozen once published — changing a live URL discards its
      -- accumulated search ranking.
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

    insert into stock_lines (
      product_id, lot_id, condition, condition_raw, msrp_cents, qty_received
    ) values (
      v_product_id, v_lot_id, map_condition(r.condition_raw), r.condition_raw,
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
