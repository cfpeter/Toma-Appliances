-- ═══════════════════════════════════════════════════════════════════════════
-- Marketplace service fee
--
-- B-Stock's invoice breaks down as:
--     winning bid + B-Stock Fee (3% of bid) + shipping = landed cost
--
-- The fee is deliberately NOT called "B-Stock fee" and NOT hardcoded at 3%:
-- every marketplace charges its own rate, so the rate lives on `sources`.
-- Adding a new marketplace is then one row, not a code change.
--
-- `premium_cents` is renamed rather than added alongside — B-Stock charges no
-- separate buyer premium, so keeping both would be two fields for one thing.
-- ═══════════════════════════════════════════════════════════════════════════

-- Fee rate per marketplace. 0.03 = 3%.
alter table sources
  add column if not exists fee_percent numeric(6, 4) not null default 0;

update sources set fee_percent = 0.03 where code like 'bstock%';

comment on column sources.fee_percent is
  'Marketplace fee as a fraction of the winning bid. B-Stock = 0.03 (3%).';

-- landed_cost_cents is generated from the column being renamed, so it has to
-- be dropped and rebuilt around the new name.
alter table lots drop column if exists landed_cost_cents;
alter table lots rename column premium_cents to service_fee_cents;

-- The rate that applied when this lot was bought. Snapshotted so that raising
-- a marketplace's fee later cannot silently rewrite historical profit.
alter table lots
  add column if not exists service_fee_rate numeric(6, 4);

alter table lots
  add column landed_cost_cents integer
  generated always as
    (bid_cents + service_fee_cents + freight_cents + other_cost_cents) stored;

comment on column lots.service_fee_cents is
  'Marketplace fee actually charged. Auto-suggested from the source rate, editable.';

-- Existing data: the fee was entered under "other costs" before this field
-- existed. Move it only where it matches the source rate to the cent, so a
-- genuine miscellaneous cost is never silently relabelled.
update lots l
   set service_fee_cents = l.other_cost_cents,
       other_cost_cents  = 0,
       service_fee_rate  = s.fee_percent
  from sources s
 where s.id = l.source_id
   and l.service_fee_cents = 0
   and l.other_cost_cents > 0
   and s.fee_percent > 0
   and l.other_cost_cents = round(l.bid_cents * s.fee_percent);

-- Anything already priced keeps its rate recorded too.
update lots l
   set service_fee_rate = s.fee_percent
  from sources s
 where s.id = l.source_id and l.service_fee_rate is null;
