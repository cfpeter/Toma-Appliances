/**
 * What the public can see.
 *
 * These run as the `anon` role -- the role the storefront actually uses --
 * because the interesting failures here are permission failures, and those
 * are invisible when you query as the owner. The bug that prompted this file
 * did exactly that: every quantity read 0 for visitors while the admin saw
 * the right number, because `product_stock` recomputed under the caller's
 * RLS and anon could not see a single stock line.
 *
 * `set local role anon` is scoped to the surrounding transaction, so the
 * rollback in withRollback restores the connection either way.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type pg from 'pg'
import { count, makeLot, one, withRollback } from './helpers.ts'

/** Run one query as anon, isolated so a permission error cannot poison the tx. */
async function asAnon<T>(db: pg.Client, fn: () => Promise<T>): Promise<T> {
  await db.query('savepoint anon_probe')
  try {
    await db.query('set local role anon')
    return await fn()
  } finally {
    await db.query('reset role')
  }
}

/** True when anon is refused outright, rather than merely served no rows. */
async function deniedToAnon(db: pg.Client, sql: string): Promise<boolean> {
  await db.query('savepoint denial_probe')
  try {
    await db.query('set local role anon')
    await db.query(sql)
    return false
  } catch (e) {
    return /permission denied/i.test((e as Error).message)
  } finally {
    try {
      await db.query('rollback to savepoint denial_probe')
    } catch {
      /* ignore */
    }
    await db.query('reset role')
  }
}

const publish = (db: pg.Client, id: string) =>
  db.query(`update products set status='active', published_at=now() where id=$1`, [id])

describe('public catalog', () => {
  test('shows the real quantity, not zero', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'PUB-1', items: [['P1', 4, 99900]] })
      const id = lot.productIds[0]
      await publish(db, id)

      const mine = await one(db, `select qty_available from product_stock where product_id=$1`, [id])
      assert.equal(mine.qty_available, 4, 'owner should see 4')

      const theirs = await asAnon(db, () => one(db, `select qty_available from catalog where id=$1`, [id]))
      assert.equal(theirs.qty_available, 4, 'the public must see the same 4')
    }))

  test('quantity drops as units sell', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'PUB-2', items: [['P1', 4, 99900]] })
      const id = lot.productIds[0]
      await publish(db, id)
      await db.query(`insert into sales (product_id, qty, sale_price_cents) values ($1,1,89900)`, [id])

      const row = await asAnon(db, () => one(db, `select qty_available from catalog where id=$1`, [id]))
      assert.equal(row.qty_available, 3)
    }))

  test('price and condition are visible', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'PUB-3', items: [['P1', 1, 99900]] })
      const id = lot.productIds[0]
      await db.query(`update products set price_cents=49900, condition='scratch_dent' where id=$1`, [id])
      await publish(db, id)

      const row = await asAnon(db, () =>
        one(db, `select price_cents, condition from catalog where id=$1`, [id]))
      assert.equal(row.price_cents, 49900)
      assert.equal(row.condition, 'scratch_dent')
    }))

  test('drafts, hidden and deleted products stay invisible', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'PUB-4', items: [['P1', 1, 99900]] })
      const id = lot.productIds[0]

      for (const status of ['draft', 'hidden', 'deleted']) {
        await db.query(`update products set status=$2 where id=$1`, [id, status])
        const n = await asAnon(db, () => count(db, `select count(*)::int n from catalog where id=$1`, [id]))
        assert.equal(n, 0, `${status} must not appear in the public catalog`)
      }
    }))

  test('sold products stay listed, at zero', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'PUB-5', items: [['P1', 1, 99900]] })
      const id = lot.productIds[0]
      await db.query(`insert into sales (product_id, qty, sale_price_cents) values ($1,1,89900)`, [id])
      await db.query(`update products set status='sold', published_at=now() where id=$1`, [id])

      const row = await asAnon(db, () => one(db, `select qty_available from catalog where id=$1`, [id]))
      assert.equal(row.qty_available, 0, 'a sold listing keeps its page but shows none left')
    }))

  test('what you paid is unreachable', async () =>
    withRollback(async (db) => {
      for (const sql of [
        'select unit_cost_cents from stock_lines limit 1',
        'select bid_cents from lots limit 1',
        'select landed_cost_cents from lots limit 1',
        'select * from product_stock limit 1',
        'select * from sales limit 1',
      ]) {
        assert.equal(await deniedToAnon(db, sql), true, `anon must be refused: ${sql}`)
      }
    }))

  test('MSRP and sourcing columns are unreachable', async () =>
    withRollback(async (db) => {
      for (const sql of [
        'select msrp_cents from products limit 1',
        'select item_no from products limit 1',
      ]) {
        assert.equal(await deniedToAnon(db, sql), true, `anon must be refused: ${sql}`)
      }
      assert.equal(
        await deniedToAnon(db, 'select condition from products limit 1'),
        false,
        'condition is public now, on purpose',
      )
    }))
})
