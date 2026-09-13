-- Default markup 45% -> 50% of MSRP.
--
-- Chosen from how the owner actually prices: a $2,000-MSRP appliance sells for
-- $1,000-1,500, i.e. 50-75% of retail. 50% is the conservative end of his own
-- range. Change `msrp_percent` in the settings table to adjust; it only ever
-- affects the SUGGESTION, never a price already set by hand.

update settings
   set value = jsonb_set(value, '{msrp_percent}', '0.50'::jsonb),
       updated_at = now()
 where key = 'pricing';
