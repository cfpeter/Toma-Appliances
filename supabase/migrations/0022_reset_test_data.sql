-- ═══════════════════════════════════════════════════════════════════════════
-- Wipe the test data, keep the setup
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The site is live while the import flow is still being exercised: upload a
-- manifest, see what it produces, throw it away, try again. That cycle needs
-- one definition of "throw it away" -- not one in a shell script and another
-- in the admin, drifting apart until one of them spares a table the other
-- does not.
--
-- KEPT: profiles (logins), categories, sources, settings, category_map. All
-- of it would otherwise have to be recreated by hand before the next run, and
-- none of it is test data.
--
-- Truncate rather than delete: it ignores foreign key order within the group
-- and leaves no dead rows behind.

create or replace function reset_test_data()
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_before jsonb;
begin
  select jsonb_build_object(
    'products',    (select count(*) from products),
    'stock_lines', (select count(*) from stock_lines),
    'sales',       (select count(*) from sales),
    'photos',      (select count(*) from product_photos),
    'lots',        (select count(*) from lots),
    'imports',     (select count(*) from imports)
  ) into v_before;

  truncate table
    sales, product_photos, stock_lines, products, import_rows, imports, lots;

  return v_before;
end $$;

-- Signed-in users only. The public has no business here, and `anon` holds no
-- grant on these tables anyway (0018).
revoke execute on function reset_test_data() from public, anon;
grant execute on function reset_test_data() to authenticated;
