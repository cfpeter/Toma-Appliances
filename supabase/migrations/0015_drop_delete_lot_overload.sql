-- 0014 added delete_lot(uuid, boolean) beside the original delete_lot(uuid),
-- so a one-argument call became ambiguous ("function is not unique").
-- The two-argument version with a defaulted flag covers both cases.
drop function if exists delete_lot(uuid);
