/**
 * Returns, and the difference between a return and a mistake.
 *
 * A returned sale stays in the history: it describes something that really
 * happened, and deleting it would make the month read as though the sale
 * never occurred. A mistaken sale is deleted, because it describes nothing.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { count, makeLot, one, withRollback } from './helpers.ts'

const sell = (db: Parameters<Parameters<typeof withRollback>[0]>[0], id: string, qty: number, cents: number) =>
  db.query(`insert into sales (product_id, qty, sale_price_cents) values ($1,$2,$3) returning id`, [
    id, qty, cents,
  ])

describe('return_sale', () => {
  it('puts the units back in stock', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'RT-1', items: [['R1', 3, 99900]] })
      const id = lot.productIds[0]
      const sale = (await sell(db, id, 2, 45000)).rows[0]

      assert.equal((await one(db, 'select qty_available q from product_stock where product_id=$1', [id])).q, 1)
      await db.query('select return_sale($1)', [sale.id])
      assert.equal(
        (await one(db, 'select qty_available q from product_stock where product_id=$1', [id])).q,
        3,
        'both units are available again',
      )
    }))

  it('brings a sold-out listing back to active', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'RT-2', items: [['R1', 1, 99900]] })
      const id = lot.productIds[0]
      await db.query(`update products set status='active' where id=$1`, [id])
      const sale = (await sell(db, id, 1, 45000)).rows[0]
      assert.equal((await one(db, 'select status from products where id=$1', [id])).status, 'sold')

      await db.query('select return_sale($1)', [sale.id])
      assert.equal(
        (await one(db, 'select status from products where id=$1', [id])).status,
        'active',
        'the listing comes back on its own',
      )
    }))

  it('keeps the row but stops it counting as revenue', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'RT-3', items: [['R1', 2, 99900]] })
      const id = lot.productIds[0]
      await db.query(`update products set price_cents=50000 where id=$1`, [id])
      const sale = (await sell(db, id, 1, 45000)).rows[0]

      const before = await one(db, 'select revenue_cents, discount_cents from sales_ledger where id=$1', [sale.id])
      assert.equal(before.revenue_cents, 45000)

      await db.query('select return_sale($1, $2)', [sale.id, 'door was dented'])

      const after = await one(db, 'select * from sales_ledger where id=$1', [sale.id])
      assert.ok(after, 'the sale is still in the history')
      assert.equal(after.revenue_cents, 0, 'it earns nothing')
      assert.equal(after.margin_cents, 0, 'and no margin')
      assert.equal(after.discount_cents, null, 'a discount on a refunded sale is meaningless')
      assert.equal(after.return_note, 'door was dented')
      assert.ok(after.returned_at)
    }))

  it('refuses to return the same sale twice', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'RT-4', items: [['R1', 2, 99900]] })
      const sale = (await sell(db, lot.productIds[0], 1, 45000)).rows[0]
      await db.query('select return_sale($1)', [sale.id])
      await db.query('savepoint s')
      await assert.rejects(() => db.query('select return_sale($1)', [sale.id]), /already marked returned/)
      await db.query('rollback to savepoint s')
    }))

  it('lets the unit be sold again afterwards', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'RT-5', items: [['R1', 1, 99900]] })
      const id = lot.productIds[0]
      const sale = (await sell(db, id, 1, 45000)).rows[0]
      await db.query('select return_sale($1)', [sale.id])

      // The oversell guard counts only sales that stuck, so this must succeed.
      await sell(db, id, 1, 42000)
      assert.equal(await count(db, 'select count(*)::int n from sales where product_id=$1', [id]), 2)
      assert.equal((await one(db, 'select qty_available q from product_stock where product_id=$1', [id])).q, 0)
    }))

  it('shows a returned unit to customers again', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'RT-6', items: [['R1', 1, 99900]] })
      const id = lot.productIds[0]
      await db.query(`update products set status='active', published_at=now() where id=$1`, [id])
      const sale = (await sell(db, id, 1, 45000)).rows[0]

      await db.query('savepoint a')
      await db.query('set local role anon')
      assert.equal((await one(db, 'select qty_available q from catalog where id=$1', [id])).q, 0)
      await db.query('reset role')

      await db.query('select return_sale($1)', [sale.id])

      await db.query('set local role anon')
      assert.equal(
        (await one(db, 'select qty_available q from catalog where id=$1', [id])).q,
        1,
        'the public catalogue has it in stock again',
      )
      await db.query('reset role')
      await db.query('rollback to savepoint a')
    }))

  it('is not callable by the public', async () =>
    withRollback(async (db) => {
      await db.query('savepoint p')
      await db.query('set local role anon')
      await assert.rejects(() => db.query('select return_sale($1)', [crypto.randomUUID()]), /permission denied/i)
      await db.query('rollback to savepoint p')
      await db.query('reset role')
    }))
})

describe('deleting a mistaken sale', () => {
  it('restores stock and leaves nothing behind', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'RT-7', items: [['R1', 1, 99900]] })
      const id = lot.productIds[0]
      const sale = (await sell(db, id, 1, 45000)).rows[0]

      await db.query('delete from sales where id=$1', [sale.id])
      assert.equal((await one(db, 'select qty_available q from product_stock where product_id=$1', [id])).q, 1)
      assert.equal(await count(db, 'select count(*)::int n from sales_ledger where id=$1', [sale.id]), 0)
    }))
})
