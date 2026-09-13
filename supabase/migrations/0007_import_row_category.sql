-- The review screen must show which of OUR categories a row will land in, not
-- just the seller's raw label. Resolved at staging time so the reviewer sees
-- the real destination and can catch a bad mapping before committing.

alter table import_rows
  add column if not exists category_id uuid references categories(id) on delete set null;

create index if not exists import_rows_category_idx on import_rows(category_id);
