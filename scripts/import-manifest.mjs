/**
 * Stage a B-Stock manifest for admin review.
 *
 * NOTHING is published by this. It creates a lot, an import record, and one
 * import_row per manifest line with a suggested action. The admin reviews,
 * adjusts, and only then commits — at which point products are created as
 * drafts, still unpublished until priced.
 *
 *   node scripts/import-manifest.mjs samples/bstock-manifest-ONT-6954689.csv
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import pg from 'pg'
import { parseCsv } from '../src/lib/import/csv.ts'
import { parseRow } from '../src/lib/import/parse.ts'
import { formatCents } from '../src/lib/money.ts'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/import-manifest.mjs <manifest.csv>')
  process.exit(1)
}

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
const db = new pg.Client({
  host: env.SUPABASE_DB_HOST,
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const rows = parseCsv(readFileSync(file, 'utf8')).map(parseRow)
if (rows.length === 0) {
  console.error('no rows found')
  process.exit(1)
}

const lotCode = rows[0].raw['Lot ID'] || basename(file)
const vendor = rows[0].raw.Vendor || null

// Category lookup: per-source override first, then the global mapping.
const mapRows = (
  await db.query(
    `select source_category, source_seller_category, category_id, source_id from category_map`,
  )
).rows
const catFor = (cat, seller) =>
  mapRows.find((m) => m.source_category === cat && m.source_seller_category === seller)
    ?.category_id ?? null

const existing = new Map(
  (await db.query(`select id, item_no, name from products where item_no is not null`)).rows.map(
    (r) => [r.item_no, r],
  ),
)

await db.query('begin')
try {
  const srcId = (await db.query(`select id from sources where code='bstock'`)).rows[0].id

  // Reuse the lot if this manifest was staged before, so re-running is safe.
  let lot = (await db.query(`select id from lots where lot_code=$1`, [lotCode])).rows[0]
  if (!lot) {
    lot = (
      await db.query(
        `insert into lots (source_id, lot_code, vendor, purchase_date)
       values ($1,$2,$3,current_date) returning id`,
        [srcId, lotCode, vendor],
      )
    ).rows[0]
  }
  await db.query(`delete from imports where lot_id=$1 and status='pending'`, [lot.id])

  const imp = (
    await db.query(
      `insert into imports (lot_id, source_id, filename, row_count, status)
     values ($1,$2,$3,$4,'pending') returning id`,
      [lot.id, srcId, basename(file), rows.length],
    )
  ).rows[0]

  const seenInFile = new Set()
  let nNew = 0,
    nMatch = 0,
    nSkip = 0

  for (const r of rows) {
    const flags = [...r.flags]
    const categoryId = catFor(r.sourceCategory, r.sourceSellerCategory)
    if (!categoryId) flags.push('unmapped_category')

    if (r.itemNo && seenInFile.has(r.itemNo)) flags.push('duplicate_in_file')
    if (r.itemNo) seenInFile.add(r.itemNo)

    const match = r.itemNo ? existing.get(r.itemNo) : null
    // Accessories default to skip — a $32 stack kit isn't worth a product page.
    const action = flags.includes('accessory') ? 'skip' : match ? 'match' : 'new'
    if (action === 'new') nNew++
    else if (action === 'match') nMatch++
    else nSkip++

    await db.query(
      `insert into import_rows (import_id, row_number, raw, item_no, upc, brand, model,
         description, qty, unit_retail_cents, source_category, source_seller_category,
         condition_raw, action, matched_product_id, flags, category_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        imp.id,
        r.rowNumber,
        JSON.stringify(r.raw),
        r.itemNo,
        r.upc,
        r.brand,
        r.model,
        r.name,
        r.qty,
        r.unitRetailCents,
        r.sourceCategory,
        r.sourceSellerCategory,
        r.conditionRaw,
        action,
        match?.id ?? null,
        JSON.stringify(flags),
        categoryId,
      ],
    )
  }

  await db.query('commit')
  const units = rows.reduce((s, r) => s + (r.qty ?? 0), 0)
  const retail = rows.reduce((s, r) => s + (r.qty ?? 0) * (r.unitRetailCents ?? 0), 0)
  console.log(`  ${basename(file)}`)
  console.log(
    `    lot ${lotCode} — ${rows.length} lines, ${units} units, ${formatCents(retail)} retail`,
  )
  console.log(`    staged: ${nNew} new · ${nMatch} match · ${nSkip} skip   [PENDING REVIEW]`)
} catch (e) {
  await db.query('rollback')
  console.error('  FAILED:', e.message)
  process.exitCode = 1
}
await db.end()
