/**
 * Recording a sale.
 *
 * The point of these is the snapshot. Prices are negotiated at the door, so
 * what a unit was listed at and what it went for are different numbers, and
 * the listed one moves afterwards. If the sale row does not capture both at
 * the moment it happens, the discount is unrecoverable a week later.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { count, makeLot, one, withRollback } from './helpers.ts'

const sell = (db: Parameters<Parameters<typeof withRollback>[0]>[0], productId: string,
              qty: number, priceCents: number, note?: string) =>
  db.query(
    `insert into sales (product_id, qty, sale_price_cents, note) values ($1,$2,$3,$4)`,
    [productId, qty, priceCents, note ?? null],
  )

/**
 * Assert a statement is refused. The failed statement aborts the surrounding
 * transaction, so it runs inside a savepoint the test can step back to and
 * carry on checking state.
 */
async function refuses(
  db: Parameters<Parameters<typeof withRollback>[0]>[0],
  fn: () => Promise<unknown>,
  re: RegExp,
  msg?: string,
) {
  await db.query('savepoint guard')
  await assert.rejects(fn, re, msg)
  await db.query('rollback to savepoint guard')
}

describe('recording a sale', () => {
  it('snapshots the asking price', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-1', items: [['S1', 2, 100000]] })
      const id = lot.productIds[0]
      await db.query(`update products set price_cents=49900 where id=$1`, [id])

      await sell(db, id, 1, 45000, 'haggled')

      const s = await one(db, `select * from sales where product_id=$1`, [id])
      assert.equal(s.list_price_cents, 49900, 'asking price is captured')
      assert.equal(s.sale_price_cents, 45000)
      assert.equal(s.note, 'haggled')
    }))

  it('keeps the old asking price when the product is repriced later', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-2', items: [['S1', 2, 100000]] })
      const id = lot.productIds[0]
      await db.query(`update products set price_cents=49900 where id=$1`, [id])
      await sell(db, id, 1, 45000)

      // Repricing next week must not rewrite what happened last week.
      await db.query(`update products set price_cents=39900 where id=$1`, [id])

      const s = await one(db, `select list_price_cents from sales where product_id=$1`, [id])
      assert.equal(s.list_price_cents, 49900, 'history is immutable')
    }))

  it('reports the discount, in both directions', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-3', items: [['S1', 3, 100000]] })
      const id = lot.productIds[0]
      await db.query(`update products set price_cents=50000 where id=$1`, [id])

      await sell(db, id, 1, 45000) // below asking
      await sell(db, id, 1, 52000) // above asking

      const rows = (
        await db.query(
          `select sale_price_cents, discount_cents, revenue_cents from sales_ledger
            where product_id=$1 order by sale_price_cents`, [id])
      ).rows
      assert.equal(rows[0].discount_cents, 5000, '$50 off')
      assert.equal(rows[1].discount_cents, -2000, 'sold over asking reads negative')
      assert.equal(rows[0].revenue_cents, 45000)
    }))

  it('lets an explicit asking price override the snapshot', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-4', items: [['S1', 1, 100000]] })
      const id = lot.productIds[0]
      await db.query(`update products set price_cents=50000 where id=$1`, [id])

      // Entering a sale after the fact, at the price it was really listed at.
      await db.query(
        `insert into sales (product_id, qty, sale_price_cents, list_price_cents)
         values ($1,1,40000,44900)`, [id])

      const s = await one(db, `select list_price_cents from sales where product_id=$1`, [id])
      assert.equal(s.list_price_cents, 44900, 'a value passed in wins over the default')
    }))

  it('snapshots unit cost and computes profit', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-5', items: [['S1', 1, 100000]] })
      await db.query(`update lots set bid_cents=30000 where id=$1`, [lot.lotId])
      await db.query('select allocate_lot_costs($1)', [lot.lotId])
      const id = lot.productIds[0]
      await db.query(`update products set price_cents=60000 where id=$1`, [id])

      await sell(db, id, 1, 55000)

      const s = await one(db, `select unit_cost_cents, margin_cents from sales_ledger where product_id=$1`, [id])
      assert.equal(s.unit_cost_cents, 30000, 'the only unit absorbs the whole landed cost')
      assert.equal(s.margin_cents, 25000, '$550 in, $300 out')
    }))

  it('holds the cost steady when the lot is re-costed afterwards', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-6', items: [['S1', 2, 100000]] })
      await db.query(`update lots set bid_cents=40000 where id=$1`, [lot.lotId])
      await db.query('select allocate_lot_costs($1)', [lot.lotId])
      const id = lot.productIds[0]
      await sell(db, id, 1, 55000)

      // Correcting the bid re-allocates live costs. The sale must not move.
      await db.query(`update lots set bid_cents=90000, costs_allocated_at=null where id=$1`, [lot.lotId])
      await db.query('select allocate_lot_costs($1)', [lot.lotId])

      const s = await one(db, `select unit_cost_cents from sales where product_id=$1`, [id])
      assert.equal(s.unit_cost_cents, 20000, 'still the cost as it stood at the sale')
    }))

  it('flips the product to sold when the last one goes, and back if undone', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-7', items: [['S1', 2, 100000]] })
      const id = lot.productIds[0]
      await db.query(`update products set status='active' where id=$1`, [id])

      await sell(db, id, 1, 45000)
      assert.equal(
        (await one(db, `select status from products where id=$1`, [id])).status,
        'active', 'one left, still for sale')

      await sell(db, id, 1, 45000)
      assert.equal(
        (await one(db, `select status from products where id=$1`, [id])).status,
        'sold', 'none left, marked sold')

      // A mistyped sale gets deleted; the listing must come back.
      await db.query(`delete from sales where product_id=$1 and id=(select id from sales where product_id=$1 limit 1)`, [id])
      assert.equal(
        (await one(db, `select status from products where id=$1`, [id])).status,
        'active', 'stock is back, so is the listing')
    }))

  it('keeps a sold product out of the public catalog only when it is gone', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-8', items: [['S1', 1, 100000]] })
      const id = lot.productIds[0]
      await db.query(`update products set status='active', published_at=now() where id=$1`, [id])
      await sell(db, id, 1, 45000)

      // status is now 'sold' -- still listed, showing none available.
      const row = await one(db, `select status, qty_available from catalog where id=$1`, [id])
      assert.equal(row.status, 'sold')
      assert.equal(row.qty_available, 0)
    }))

  it('refuses to sell more than exists', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-9', items: [['S1', 1, 100000]] })
      const id = lot.productIds[0]

      await refuses(
        db,
        () => sell(db, id, 5, 45000),
        /Not enough stock/,
        'overselling must be refused, not merely discouraged by the form',
      )
    }))

  it('refuses a second sale that would exceed what is left', async () =>
    withRollback(async (db) => {
      // The double-click case: two sales, each individually plausible.
      const lot = await makeLot(db, { code: 'SL-10', items: [['S1', 1, 100000]] })
      const id = lot.productIds[0]
      await sell(db, id, 1, 45000)

      await refuses(db, () => sell(db, id, 1, 45000), /Not enough stock/)

      const stock = await one(db, `select qty_available from product_stock where product_id=$1`, [id])
      assert.equal(stock.qty_available, 0, 'never negative')
    }))
})
