#!/usr/bin/env node
/**
 * Wipe the test data, keep the setup.
 *
 * Used constantly while the import flow is being exercised: upload a manifest,
 * see what it produces, throw it away, try again. What gets kept is everything
 * you would otherwise have to recreate by hand before the next run.
 *
 *   node scripts/reset-data.mjs          # dry run — shows what would go
 *   node scripts/reset-data.mjs --yes    # actually do it
 *
 * WIPED   products, stock_lines, sales, product_photos, lots, imports,
 *         import_rows, and the photo objects in the local R2 store
 * KEPT    profiles (your login), categories, sources, settings, category_map,
 *         _migrations
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import pg from 'pg'

const WIPE = [
  'sales',
  'product_photos',
  'stock_lines',
  'products',
  'import_rows',
  'imports',
  'lots',
]
const KEEP = ['profiles', 'categories', 'sources', 'settings', 'category_map', '_migrations']

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const ref = env.PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1]

const go = process.argv.includes('--yes')
const db = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const counts = async (tables) => {
  const out = {}
  for (const t of tables) {
    out[t] = Number((await db.query(`select count(*)::int n from ${t}`)).rows[0].n)
  }
  return out
}

/**
 * Anything with a foreign key INTO the wipe list that is not itself being
 * wiped would either block the truncate or be silently emptied by a CASCADE.
 * Better to find out here than to discover it after the fact.
 */
const { rows: strays } = await db.query(
  `select distinct tc.table_name
     from information_schema.table_constraints tc
     join information_schema.constraint_column_usage ccu
       on ccu.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY'
      and ccu.table_name = any($1)
      and tc.table_name <> all($1)
      and tc.table_schema = 'public'`,
  [WIPE],
)

const before = await counts([...WIPE, ...KEEP])
console.log(`\n  project ${ref}\n`)
console.log('  WIPE')
for (const t of WIPE) console.log(`    ${t.padEnd(16)} ${String(before[t]).padStart(6)}`)
console.log('\n  KEEP')
for (const t of KEEP) console.log(`    ${t.padEnd(16)} ${String(before[t]).padStart(6)}`)

if (strays.length) {
  console.log(`\n  ⚠️  these reference wiped tables and are NOT in the list: ${strays.map((r) => r.table_name).join(', ')}`)
  console.log('     Refusing to run — add them to WIPE or KEEP deliberately.\n')
  await db.end()
  process.exit(1)
}

if (!go) {
  console.log('\n  Dry run. Add --yes to actually delete.\n')
  await db.end()
  process.exit(0)
}

// One transaction: either the whole reset happens or none of it does.
await db.query('begin')
try {
  await db.query(`truncate table ${WIPE.join(', ')}`)
  await db.query('commit')
} catch (e) {
  await db.query('rollback')
  console.error(`\n  ✗ rolled back: ${e.message}\n`)
  await db.end()
  process.exit(1)
}

// Deleting the product_photos rows leaves the image objects behind, and they
// are unreachable once nothing points at them. Local development uses
// miniflare's on-disk R2, so the objects are simply a directory.
// (A deployed bucket needs `wrangler r2 object delete` or a lifecycle rule --
// nothing here can reach it.)
const localR2 = new URL('../.wrangler/state/v3/r2', import.meta.url)
let photosCleared = false
if (existsSync(localR2)) {
  rmSync(localR2, { recursive: true, force: true })
  photosCleared = true
}

const after = await counts([...WIPE, ...KEEP])
const kept = KEEP.every((t) => after[t] === before[t])
console.log('\n  ✅ wiped\n')
if (photosCleared) console.log('    local photo objects cleared (.wrangler/state/v3/r2)')
for (const t of KEEP) {
  console.log(`    kept ${t.padEnd(16)} ${String(after[t]).padStart(6)}${after[t] === before[t] ? '' : '  ⚠️ CHANGED'}`)
}
const logins = (await db.query('select email from profiles order by email')).rows.map((r) => r.email)
console.log(`\n  logins intact: ${logins.join(', ')}`)
console.log(kept ? '\n  Ready for the next manifest.\n' : '\n  ⚠️ something in KEEP changed — check above.\n')

await db.end()
