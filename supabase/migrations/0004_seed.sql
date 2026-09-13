-- ═══════════════════════════════════════════════════════════════════════════
-- Seed data — sources, category tree, category mappings, default settings
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Sources ────────────────────────────────────────────────────────────────
-- Each B-Stock marketplace uses its own category names and its own item
-- description style, so parsing rules live per source.

insert into sources (code, name, parse_rules, notes) values
  ('bstock',          'B-Stock (any marketplace)',
   '{"brand_prefixes": {"SS":"Samsung","LG":"LG","EL":"Electrolux","MD":"Midea",
                        "GE":"GE","HS":"Hisense","WP":"Whirlpool","FR":"Frigidaire"},
     "strip_tokens": ["@"],
     "model_regex": "\\b[A-Z]{2,4}[0-9][A-Z0-9-]{3,}\\b"}'::jsonb,
   'All B-Stock manifests share one column layout — verified across two lots.'),
  ('bstock_costco',   'Costco Liquidation (B-Stock)',  '{}'::jsonb, 'Overrides only'),
  ('bstock_walmart',  'Walmart Liquidation (B-Stock)', '{}'::jsonb, 'Overrides only'),
  ('bstock_bestbuy',  'Best Buy Liquidation (B-Stock)','{}'::jsonb, 'Overrides only'),
  ('manual',          'Manual entry',                  '{}'::jsonb, 'Added by hand, no manifest')
on conflict (code) do nothing;

-- ── Category tree ──────────────────────────────────────────────────────────

insert into categories (parent_id, name, slug, sort_order) values
  (null, 'Laundry',     'laundry',     10),
  (null, 'Kitchen',     'kitchen',     20),
  (null, 'Accessories', 'accessories', 30)
on conflict do nothing;

insert into categories (parent_id, name, slug, sort_order)
select c.id, v.name, v.slug, v.sort_order
from categories c
join (values
  ('laundry', 'Washers',              'washers',              10),
  ('laundry', 'Dryers',               'dryers',               20),
  ('laundry', 'Washer & Dryer Sets',  'washer-dryer-sets',    30),
  ('laundry', 'All-in-One Combos',    'all-in-one-combos',    40),
  ('kitchen', 'Refrigerators',        'refrigerators',        10),
  ('kitchen', 'Ranges & Ovens',       'ranges-ovens',         20),
  ('kitchen', 'Dishwashers',          'dishwashers',          30),
  ('kitchen', 'Microwaves',           'microwaves',           40),
  ('kitchen', 'Freezers',             'freezers',             50),
  ('kitchen', 'Range Hoods',          'range-hoods',          60),
  ('accessories', 'Pedestals',        'pedestals',            10),
  ('accessories', 'Stacking Kits',    'stacking-kits',        20),
  ('accessories', 'Parts & Other',    'parts-other',          30)
) as v(parent_slug, name, slug, sort_order) on c.slug = v.parent_slug and c.parent_id is null
on conflict do nothing;

-- ── Category mapping ───────────────────────────────────────────────────────
-- Seller taxonomy → ours. source_id NULL means "applies to every source".
-- B-Stock uses one category vocabulary across its marketplaces — verified
-- against both sample manifests (a Samsung truckload and a mixed LG/Samsung/
-- Electrolux load). A per-source row can override any of these later.

insert into category_map (source_id, source_category, source_seller_category, category_id)
select null, v.src_cat, v.src_seller, c.id
from (values
  ('LAUNDRY_APPLIANCES',     'Washers',          'washers'),
  ('LAUNDRY_APPLIANCES',     'Dryers',           'dryers'),
  -- LG WashTower-style stacked units
  ('LAUNDRY_APPLIANCES',     'Laundry Suites',   'washer-dryer-sets'),
  ('KITCHEN_APPLIANCES',     'Refrigerators',    'refrigerators'),
  ('KITCHEN_APPLIANCES',     'Ranges',           'ranges-ovens'),
  ('KITCHEN_APPLIANCES',     'Dishwashers',      'dishwashers'),
  ('KITCHEN_APPLIANCES',     'Freezers',         'freezers'),
  ('KITCHEN_APPLIANCES',     'Microwaves',       'microwaves'),
  -- Pedestals and stacking kits arrive under this junk seller category. They
  -- are accessories, not appliances, and must not sit beside the dryers.
  ('MIXED_MAJOR_APPLIANCES', 'Appliances',       'pedestals'),
  ('MIXED_MAJOR_APPLIANCES', 'Major Appliances', 'all-in-one-combos')
) as v(src_cat, src_seller, target_slug)
join categories c on c.slug = v.target_slug
on conflict do nothing;

-- ── Default settings ───────────────────────────────────────────────────────

insert into settings (key, value) values
  -- Suggested price: cost × multiplier once the lot cost is known, otherwise a
  -- percentage of MSRP. Both overridable per product, and per category here.
  ('pricing', '{
     "cost_multiplier": 2.5,
     "msrp_percent": 0.35,
     "prefer": "cost",
     "round_to_cents": 900,
     "category_overrides": {}
   }'::jsonb),
  ('business', '{
     "name": "Toma Appliances",
     "phone": "",
     "email": "",
     "show_address": false,
     "area_text": "Greater Los Angeles — by appointment",
     "hours": "By appointment"
   }'::jsonb),
  ('catalog', '{
     "show_exact_quantity": true,
     "show_sold_items": true,
     "show_condition": false
   }'::jsonb)
on conflict (key) do nothing;
