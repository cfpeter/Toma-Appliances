/**
 * Test helpers.
 *
 * Every test runs inside a transaction that is ROLLED BACK afterwards, so the
 * suite can be pointed at the real database without ever leaving data behind.
 * These are integration tests on purpose: the logic under test lives in
 * Postgres functions, so mocking the database would test nothing that matters.
 */
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

const ref = env.PUBLIC_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)![1]

export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({
    host: env.SUPABASE_DB_HOST,
    port: 5432,
    user: `postgres.${ref}`,
    password: env.SUPABASE_DB_PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  return client
}

/** Run a test body in a transaction and always roll it back. */
export async function withRollback(body: (db: pg.Client) => Promise<void>): Promise<void> {
  const db = await connect()
  try {
    await db.query('begin')
    await body(db)
  } finally {
    try {
      await db.query('rollback')
    } catch {
      /* transaction may already be aborted */
    }
    await db.end()
  }
}

export const one = async (db: pg.Client, sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows[0]

export const count = async (db: pg.Client, sql: string, params: unknown[] = []) =>
  Number((await db.query(sql, params)).rows[0].n)

export interface LotFixture {
  lotId: string
  importId: string
  lotCode: string
  productIds: string[]
}

/**
 * Build a lot, stage a manifest for it, and commit — the same path the app
 * uses, so tests exercise real behaviour rather than hand-inserted rows.
 */
export async function makeLot(
  db: pg.Client,
  opts: {
    code: string
    /** [itemNo, qty, msrpCents, action] */
    items: [string, number, number, ('new' | 'match' | 'skip')?][]
    bidCents?: number
    commit?: boolean
  },
): Promise<LotFixture> {
  const source = await one(db, `select id from sources where code='bstock'`)
  const category = await one(db, `select id from categories where slug='washers'`)

  const lot = await one(
    db,
    `insert into lots (source_id, lot_code, vendor, purchase_date, bid_cents)
     values ($1,$2,'TEST VENDOR',current_date,$3) returning id`,
    [source.id, opts.code, opts.bidCents ?? 0],
  )

  const imp = await one(
    db,
    `insert into imports (lot_id, source_id, filename, row_count, status)
     values ($1,$2,$3,$4,'pending') returning id`,
    [lot.id, source.id, `${opts.code}.csv`, opts.items.length],
  )

  for (const [i, [itemNo, qty, msrp, action]] of opts.items.entries()) {
    await db.query(
      `insert into import_rows (import_id, row_number, raw, item_no, brand, model,
         description, qty, unit_retail_cents, condition_raw, action, category_id)
       values ($1,$2,'{}'::jsonb,$3,'TestBrand',$4,$5,$6,$7,'USED',$8,$9)`,
      [
        imp.id,
        i,
        itemNo,
        `M-${itemNo}`,
        `Test Product ${itemNo}`,
        qty,
        msrp,
        action ?? 'new',
        category.id,
      ],
    )
  }

  if (opts.commit !== false) {
    await db.query('select commit_import($1)', [imp.id])
  }

  const products = (
    await db.query(`select distinct sl.product_id from stock_lines sl where sl.lot_id=$1`, [lot.id])
  ).rows.map((r) => r.product_id as string)

  return { lotId: lot.id, importId: imp.id, lotCode: opts.code, productIds: products }
}
