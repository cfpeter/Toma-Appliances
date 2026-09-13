import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { count, makeLot, one, withRollback } from './helpers.ts'

describe('commit_import', () => {
  it('creates products as drafts with a suggested price', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'CI-1', items: [['C1', 2, 100000]] })
      const p = await one(
        db,
        `select p.status, p.price_cents, p.msrp_cents from products p
          join stock_lines sl on sl.product_id=p.id where sl.lot_id=$1`,
        [lot.lotId],
      )
      assert.equal(p.status, 'draft', 'never published straight from an import')
      assert.equal(p.msrp_cents, 100000)
      assert.ok(p.price_cents > 0, 'a price should be suggested')
      assert.ok(p.price_cents < p.msrp_cents, 'suggestion must be below MSRP')
    })
  })

  it('honours skip rows — no product, no stock', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, {
        code: 'CI-2',
        items: [
          ['C2', 1, 100000],
          ['C3', 1, 5000, 'skip'],
        ],
      })
      assert.equal(
        await count(db, 'select count(*)::int n from stock_lines where lot_id=$1', [lot.lotId]),
        1,
      )
      assert.equal(await count(db, `select count(*)::int n from products where item_no='C3'`), 0)
    })
  })

  it('adds to existing stock on a match instead of duplicating the product', async () => {
    await withRollback(async (db) => {
      await makeLot(db, { code: 'CI-3a', items: [['DUP', 2, 100000]] })
      await makeLot(db, { code: 'CI-3b', items: [['DUP', 3, 100000, 'match']] })
      assert.equal(
        await count(db, `select count(*)::int n from products where item_no='DUP'`),
        1,
        'one product, not two listings',
      )
      assert.equal(
        await count(
          db,
          `select coalesce(sum(sl.qty_received),0)::int n from stock_lines sl
           join products p on p.id=sl.product_id where p.item_no='DUP'`,
        ),
        5,
      )
    })
  })

  it('refuses to commit the same import twice', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'CI-4', items: [['C4', 1, 100000]] })
      await assert.rejects(
        () => db.query('select commit_import($1)', [lot.importId]),
        /already committed/,
      )
    })
  })

  it('gives every product a unique slug', async () => {
    await withRollback(async (db) => {
      await makeLot(db, {
        code: 'CI-5',
        items: [
          ['S1', 1, 100000],
          ['S2', 1, 100000],
        ],
      })
      const r = await one(
        db,
        `select count(*)::int total, count(distinct slug)::int uniq from products`,
      )
      assert.equal(r.total, r.uniq, 'slugs must not collide')
    })
  })
})

describe('revert_import', () => {
  it('removes the products it created and returns to pending', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, {
        code: 'RV-1',
        items: [
          ['R1', 2, 100000],
          ['R2', 1, 100000],
        ],
      })
      const r = await one(db, 'select revert_import($1) r', [lot.importId])
      assert.equal(r.r.products_removed, 2)
      assert.equal(
        await count(db, 'select count(*)::int n from stock_lines where lot_id=$1', [lot.lotId]),
        0,
      )
      const imp = await one(db, 'select status from imports where id=$1', [lot.importId])
      assert.equal(imp.status, 'pending', 'so it can be reviewed again')
    })
  })

  it('keeps a product that has been sold', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, {
        code: 'RV-2',
        items: [
          ['R3', 2, 100000],
          ['R4', 2, 100000],
        ],
      })
      await db.query('insert into sales (product_id, qty, sale_price_cents) values ($1,1,50000)', [
        lot.productIds[0],
      ])
      const r = await one(db, 'select revert_import($1) r', [lot.importId])
      assert.equal(r.r.products_kept_because_sold, 1)
      assert.equal(
        await count(db, 'select count(*)::int n from products where id=$1', [lot.productIds[0]]),
        1,
      )
    })
  })
  it('leaves products from other imports alone', async () =>
    withRollback(async (db) => {
      // Two independent lots. Reverting one must not reach into the other --
      // the orphan sweep used to be unscoped and deleted every stockless
      // product in the database, whichever import had created it.
      const a = await makeLot(db, { code: 'REV-A', items: [['A1', 2, 99900]] })
      const b = await makeLot(db, { code: 'REV-B', items: [['B1', 2, 88800]] })

      // A bystander with no stock and no sales: exactly what the old sweep ate.
      const bystander = await one(
        db,
        `insert into products (name, slug, status) values ('Hand-typed unit','hand-typed-unit','draft') returning id`,
      )

      await db.query('select revert_import($1)', [a.importId])

      assert.equal(
        await count(db, `select count(*)::int n from products where id=$1`, [b.productIds[0]]),
        1,
        "the other lot's product must survive",
      )
      assert.equal(
        await count(db, `select count(*)::int n from products where id=$1`, [bystander.id]),
        1,
        'a product this import never touched must survive',
      )
      assert.equal(
        await count(db, `select count(*)::int n from products where id=$1`, [a.productIds[0]]),
        0,
        "this import's own product is still cleaned up",
      )
    }))

})

describe('allocate_lot_costs', () => {
  it('splits the landed cost in proportion to retail value', async () => {
    await withRollback(async (db) => {
      // 1 x $1000 and 1 x $3000 retail => 25% / 75% of a $4,000 landed cost
      const lot = await makeLot(db, {
        code: 'AL-1',
        items: [
          ['A1', 1, 100000],
          ['A2', 1, 300000],
        ],
        bidCents: 400000,
      })
      await db.query('select allocate_lot_costs($1)', [lot.lotId])

      const rows = (
        await db.query(
          `select sl.unit_cost_cents, sl.msrp_cents from stock_lines sl
          where sl.lot_id=$1 order by sl.msrp_cents`,
          [lot.lotId],
        )
      ).rows
      assert.equal(rows[0].unit_cost_cents, 100000, 'cheap unit absorbs 25%')
      assert.equal(rows[1].unit_cost_cents, 300000, 'expensive unit absorbs 75%')
    })
  })

  it('records the rounding remainder so the lot reconciles exactly', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, {
        code: 'AL-2',
        items: [
          ['A3', 3, 100000],
          ['A4', 3, 100001],
        ],
        bidCents: 100000,
      })
      await db.query('select allocate_lot_costs($1)', [lot.lotId])
      const l = await one(
        db,
        'select landed_cost_cents, allocation_residual_cents from lots where id=$1',
        [lot.lotId],
      )
      const allocated = await count(
        db,
        'select coalesce(sum(qty_received*unit_cost_cents),0)::int n from stock_lines where lot_id=$1',
        [lot.lotId],
      )
      assert.equal(
        allocated + l.allocation_residual_cents,
        l.landed_cost_cents,
        'allocated + residual must equal what was actually paid',
      )
    })
  })

  it('falls back to an even split when no MSRP is known', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, {
        code: 'AL-3',
        items: [
          ['A5', 2, 0],
          ['A6', 2, 0],
        ],
        bidCents: 40000,
      })
      await db.query('select allocate_lot_costs($1)', [lot.lotId])
      const rows = (
        await db.query('select unit_cost_cents from stock_lines where lot_id=$1', [lot.lotId])
      ).rows
      for (const r of rows) assert.equal(r.unit_cost_cents, 10000, '$400 over 4 units')
    })
  })
})

describe('product status', () => {
  it('flips to sold when the last unit goes, and back when stock returns', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'ST-1', items: [['T1', 2, 100000]] })
      const id = lot.productIds[0]
      await db.query(`update products set status='active' where id=$1`, [id])

      const sale = await one(
        db,
        'insert into sales (product_id, qty, sale_price_cents) values ($1,1,50000) returning id',
        [id],
      )
      assert.equal(
        (await one(db, 'select status from products where id=$1', [id])).status,
        'active',
        'still active with stock left',
      )

      await db.query('insert into sales (product_id, qty, sale_price_cents) values ($1,1,50000)', [
        id,
      ])
      assert.equal(
        (await one(db, 'select status from products where id=$1', [id])).status,
        'sold',
        'auto-sold at zero',
      )

      await db.query('delete from sales where id=$1', [sale.id])
      assert.equal(
        (await one(db, 'select status from products where id=$1', [id])).status,
        'active',
        'back to active when stock returns',
      )
    })
  })

  it('derives quantity as received minus sold', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'ST-2', items: [['T2', 5, 100000]] })
      await db.query('insert into sales (product_id, qty, sale_price_cents) values ($1,2,50000)', [
        lot.productIds[0],
      ])
      const s = await one(db, 'select * from product_stock where product_id=$1', [
        lot.productIds[0],
      ])
      assert.equal(s.qty_received, 5)
      assert.equal(s.qty_sold, 2)
      assert.equal(s.qty_available, 3)
    })
  })
})
