import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const ref = env.PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1]
const c = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await c.connect()

const q = async (s, p) => (await c.query(s, p)).rows

console.log('── tables ──')
const t = await q(`select table_name from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE' order by 1`)
console.log(`  ${t.map((r) => r.table_name).join(', ')}`)

console.log('\n── views ──')
const v = await q(
  `select table_name from information_schema.views where table_schema='public' order by 1`,
)
console.log(`  ${v.map((r) => r.table_name).join(', ')}`)

console.log('\n── seed ──')
for (const tbl of ['sources', 'categories', 'category_map', 'settings']) {
  const [{ n }] = await q(`select count(*)::int n from ${tbl}`)
  console.log(`  ${tbl.padEnd(14)} ${n} rows`)
}
console.log('  category tree:')
for (const r of await q(`select p.name parent, c.name child from categories c
    left join categories p on p.id=c.parent_id where c.parent_id is not null
    order by p.sort_order, c.sort_order`))
  console.log(`    ${r.parent} → ${r.child}`)

console.log('\n── RLS enabled? ──')
const rls = await q(`select relname, relrowsecurity from pg_class
  where relnamespace='public'::regnamespace and relkind='r' order by 1`)
const off = rls.filter((r) => !r.relrowsecurity).map((r) => r.relname)
console.log(
  off.length ? `  ❌ RLS OFF for: ${off.join(', ')}` : `  ✅ RLS on for all ${rls.length} tables`,
)

console.log('\n── column grants for the public (anon) role on products ──')
const g = await q(`select column_name from information_schema.column_privileges
  where table_name='products' and grantee='anon' and privilege_type='SELECT' order by 1`)
const granted = g.map((r) => r.column_name)
console.log(`  visible: ${granted.join(', ')}`)
const secret = ['msrp_cents', 'condition', 'item_no', 'created_by']
const leaked = secret.filter((s) => granted.includes(s))
console.log(
  leaked.length
    ? `  ❌ LEAKED: ${leaked.join(', ')}`
    : '  ✅ msrp_cents, condition, item_no, created_by all hidden',
)

await c.end()
