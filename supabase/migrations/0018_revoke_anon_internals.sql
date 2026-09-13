-- ═══════════════════════════════════════════════════════════════════════════
-- Defence in depth: take the public's table grants away, not just its rows
-- ═══════════════════════════════════════════════════════════════════════════
--
-- These tables were already unreadable by `anon` -- RLS denies by default and
-- no policy was ever written for them. But the underlying GRANTs were still
-- in place (Supabase hands anon a blanket grant on the public schema), so the
-- only thing standing between the public and every purchase price was one
-- policy that nobody had written yet. A future `create policy ... for select
-- to anon` on the wrong table would have leaked cost data instantly.
--
-- Probed as anon before this ran: `select unit_cost_cents from stock_lines`
-- was permitted and returned zero rows. Permitted is the part worth removing.
--
-- The public needs `catalog`, plus the column-grants on products,
-- product_photos and categories from 0003. Nothing else.

revoke all on lots        from anon;
revoke all on stock_lines from anon;
revoke all on sales       from anon;
revoke all on imports     from anon;
revoke all on import_rows from anon;
revoke all on profiles    from anon;

-- settings and category_map are deliberately left as they are: no policy, no
-- rows, no secrets, and the storefront will shortly need a public path to the
-- business phone and hours.
