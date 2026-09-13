-- ═══════════════════════════════════════════════════════════════════════════
-- What the storefront is allowed to know about the business
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `settings` stays invisible to the public: it holds the pricing rules, and a
-- competitor reading the markup is exactly the kind of thing RLS is for. But
-- the storefront has to render a phone number and opening hours, so a narrow
-- definer view exposes those fields and nothing else.
--
-- Named fields rather than the whole `business` blob on purpose: a key added
-- later is private until somebody deliberately adds it here.

create or replace view public_business
with (security_invoker = false) as
select
  coalesce(b.value->>'name', 'Toma Appliances')  as name,
  coalesce(b.value->>'phone', '')                as phone,
  coalesce(b.value->>'email', '')                as email,
  coalesce(b.value->>'hours', '')                as hours,
  coalesce(b.value->>'area_text', '')            as area_text,
  coalesce(b.value->>'delivery', '')             as delivery,
  coalesce(b.value->>'warranty', '')             as warranty,
  coalesce(b.value->>'about', '')                as about,
  coalesce((c.value->>'show_exact_quantity')::boolean, true) as show_exact_quantity,
  coalesce((c.value->>'show_sold_items')::boolean, true)     as show_sold_items
from (select value from settings where key = 'business') b
cross join (select value from settings where key = 'catalog') c;

grant select on public_business to anon, authenticated;

-- Condition became public on 2026-09-13 (decision 21); this flag still said
-- otherwise, and a stale flag is worse than no flag.
update settings
   set value = jsonb_set(value, '{show_condition}', 'true')
 where key = 'catalog';

-- Fields the storefront renders that the seed never had.
update settings
   set value = value
     || jsonb_build_object(
          'delivery', coalesce(value->>'delivery', ''),
          'warranty', coalesce(value->>'warranty', ''),
          'about',    coalesce(value->>'about', '')
        )
 where key = 'business';
