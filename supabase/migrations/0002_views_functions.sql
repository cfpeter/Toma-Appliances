-- ═══════════════════════════════════════════════════════════════════════════
-- Views and functions
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Quantity is DERIVED, never stored ──────────────────────────────────────
-- A qty column written by three different code paths will eventually disagree
-- with reality. A calculation cannot. At this scale the cost is nil.

create view product_stock
with (security_invoker = true) as
select
  p.id as product_id,
  coalesce(sl.qty_received, 0)                         as qty_received,
  coalesce(sa.qty_sold, 0)                             as qty_sold,
  coalesce(sl.qty_received, 0) - coalesce(sa.qty_sold, 0) as qty_available
from products p
left join (
  select product_id, sum(qty_received)::int as qty_received
  from stock_lines group by product_id
) sl on sl.product_id = p.id
left join (
  select product_id, sum(qty)::int as qty_sold
  from sales group by product_id
) sa on sa.product_id = p.id;

-- ── Public catalog view ────────────────────────────────────────────────────
-- Public-safe columns only. No cost, no MSRP, no condition, no item_no.
-- security_invoker keeps the caller's RLS in force rather than the view
-- owner's — without it a view silently becomes a way around RLS.

create view catalog
with (security_invoker = true) as
select
  p.id, p.upc, p.brand, p.model, p.name, p.slug, p.description,
  p.category_id, p.price_cents, p.status, p.published_at, p.created_at,
  st.qty_available
from products p
join product_stock st on st.product_id = p.id
where p.status in ('active', 'sold');

-- ── Lot cost allocation ────────────────────────────────────────────────────
-- The manifest never says what you paid. You paid a lump sum for the whole
-- truckload, so cost per unit is allocated in proportion to retail value:
-- expensive units absorb more, cheap ones less.
--
-- Writes unit_cost_cents onto every stock line in the lot. Frozen afterwards.

create or replace function allocate_lot_costs(p_lot_id uuid)
returns integer
language plpgsql
security invoker
as $$
declare
  v_landed        bigint;
  v_total_retail  bigint;
  v_total_qty     bigint;
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
    -- No MSRP data anywhere in the lot — fall back to an even split per unit
    update stock_lines
       set unit_cost_cents = round(v_landed::numeric / v_total_qty::numeric)::int
     where lot_id = p_lot_id;
  end if;

  get diagnostics v_updated = row_count;
  update lots set costs_allocated_at = now() where id = p_lot_id;
  return v_updated;
end $$;

-- ── Auto-create a profile when a user is invited ───────────────────────────

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── Flip a product to 'sold' when the last unit goes ───────────────────────
-- 4 in stock, sell 1 → qty 3, still active. Sell the last → status 'sold'.
-- Manual override is always allowed; this only fires on quantity changes.

create or replace function sync_product_status()
returns trigger
language plpgsql
security invoker
as $$
declare
  v_product uuid := coalesce(new.product_id, old.product_id);
  v_avail   integer;
begin
  select qty_available into v_avail from product_stock where product_id = v_product;

  update products
     set status = case
           when v_avail <= 0 and status = 'active' then 'sold'::product_status
           when v_avail  > 0 and status = 'sold'   then 'active'::product_status
           else status
         end
   where id = v_product;

  return null;
end $$;

create trigger sales_sync_status
  after insert or update or delete on sales
  for each row execute function sync_product_status();

create trigger stock_lines_sync_status
  after insert or update or delete on stock_lines
  for each row execute function sync_product_status();
