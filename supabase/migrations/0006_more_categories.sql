-- ═══════════════════════════════════════════════════════════════════════════
-- Categories and mappings found in the third sample manifest (ONT-6963173):
--   * KITCHEN_APPLIANCES / Cooktops       — new subcategory needed
--   * MIXED_SMALL_APPLIANCES / Microwaves — a category prefix not seen before
-- ═══════════════════════════════════════════════════════════════════════════

insert into categories (parent_id, name, slug, sort_order)
select c.id, 'Cooktops', 'cooktops', 25
from categories c where c.slug = 'kitchen' and c.parent_id is null
on conflict do nothing;

insert into category_map (source_id, source_category, source_seller_category, category_id)
select null, v.src_cat, v.src_seller, c.id
from (values
  ('KITCHEN_APPLIANCES',     'Cooktops',   'cooktops'),
  ('MIXED_SMALL_APPLIANCES', 'Microwaves', 'microwaves'),
  -- Small-appliance lots can also carry these; map them ahead of time so the
  -- reviewer isn't interrupted by an unmapped category later.
  ('MIXED_SMALL_APPLIANCES', 'Appliances', 'parts-other'),
  ('MIXED_MAJOR_APPLIANCES', 'Washers',       'washers'),
  ('MIXED_MAJOR_APPLIANCES', 'Dryers',        'dryers'),
  ('MIXED_MAJOR_APPLIANCES', 'Refrigerators', 'refrigerators')
) as v(src_cat, src_seller, target_slug)
join categories c on c.slug = v.target_slug
on conflict do nothing;
