-- ═══════════════════════════════════════════════════════════════════════════
-- Committing a reviewed import
--
-- This is the step that turns staged manifest rows into real inventory:
--   action 'new'   → create a product (as a DRAFT) + a stock line
--   action 'match' → add a stock line to the product that already exists
--   action 'skip'  → nothing
--
-- Products land as drafts with a SUGGESTED price, never published. They only
-- go live when the owner reviews the pricing.
--
-- Written as one database function so the whole commit is a single
-- transaction: it either all lands or none of it does. A half-committed
-- truckload would be very unpleasant to unpick by hand.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function slugify(txt text)
returns text language sql immutable as $$
  select trim(both '-' from
    regexp_replace(lower(coalesce(txt, '')), '[^a-z0-9]+', '-', 'g'))
$$;

/** B-Stock's condition wording -> our enum. Unknown values fall back to 'used'. */
create or replace function map_condition(raw text)
returns item_condition language sql immutable as $$
  select case upper(coalesce(raw, ''))
    when 'NEW'            then 'new'
    when 'OPEN_BOX'       then 'open_box'
    when 'SCRATCH_DENT'   then 'scratch_dent'
    when 'SALVAGE'        then 'for_parts'
    when 'FOR_PARTS'      then 'for_parts'
    else 'used'
  end::item_condition
$$;

create or replace function commit_import(p_import_id uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_lot_id     uuid;
  v_status     import_status;
  v_landed     integer;
  v_pricing    jsonb;
  v_pct        numeric;
  v_round      integer;
  r            record;
  v_product_id uuid;
  v_slug       text;
  v_base       text;
  v_n          integer;
  v_price      integer;
  v_created    integer := 0;
  v_matched    integer := 0;
  v_skipped    integer := 0;
begin
  select lot_id, status into v_lot_id, v_status from imports where id = p_import_id;
  if v_lot_id is null and v_status is null then
    raise exception 'Import % not found', p_import_id;
  end if;
  if v_status <> 'pending' then
    raise exception 'Import % is already %', p_import_id, v_status;
  end if;

  -- Suggested pricing rule. Cost isn't known until the lot cost is entered and
  -- allocated, so at commit time we price off MSRP.
  select value into v_pricing from settings where key = 'pricing';
  v_pct   := coalesce((v_pricing ->> 'msrp_percent')::numeric, 0.35);
  v_round := coalesce((v_pricing ->> 'round_to_cents')::int, 900);

  for r in
    select * from import_rows where import_id = p_import_id order by row_number
  loop
    if r.action = 'skip' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if r.action = 'match' and r.matched_product_id is not null then
      v_product_id := r.matched_product_id;
      v_matched := v_matched + 1;
    else
      -- Build a unique, stable slug. Once published a slug is never changed —
      -- changing a live URL discards its accumulated search ranking.
      v_base := slugify(coalesce(nullif(concat_ws(' ', r.brand, r.model), ' '), r.description));
      if v_base = '' or v_base is null then
        v_base := 'item-' || replace(p_import_id::text, '-', '')  || '-' || r.row_number;
      end if;
      v_slug := v_base;
      v_n := 1;
      while exists (select 1 from products where slug = v_slug) loop
        v_n := v_n + 1;
        v_slug := v_base || '-' || v_n;
      end loop;

      v_price := case
        when r.unit_retail_cents is null or r.unit_retail_cents = 0 then null
        else greatest(
          (floor((r.unit_retail_cents * v_pct) / 10000) * 10000 + v_round)::int,
          v_round
        )
      end;

      insert into products (
        item_no, upc, brand, model, name, slug, category_id,
        condition, msrp_cents, price_cents, status
      ) values (
        r.item_no, r.upc, r.brand, r.model, r.description, v_slug, r.category_id,
        map_condition(r.condition_raw), r.unit_retail_cents, v_price, 'draft'
      )
      on conflict (item_no) where item_no is not null
        do update set updated_at = now()
      returning id into v_product_id;

      if v_product_id is null then
        select id into v_product_id from products where item_no = r.item_no;
        v_matched := v_matched + 1;
      else
        v_created := v_created + 1;
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

  -- If the lot cost is already known, allocate it now. Otherwise allocation
  -- runs when the owner enters the cost.
  select landed_cost_cents into v_landed from lots where id = v_lot_id;
  if coalesce(v_landed, 0) > 0 then
    perform allocate_lot_costs(v_lot_id);
  end if;

  return jsonb_build_object(
    'created', v_created, 'matched', v_matched, 'skipped', v_skipped,
    'allocated', coalesce(v_landed, 0) > 0
  );
end $$;
