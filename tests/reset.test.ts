/**
 * reset_test_data.
 *
 * The site is live while the import flow is still being exercised, so this
 * function deletes production rows on purpose. What matters is the boundary:
 * everything the next test run would otherwise have to be rebuilt by hand --
 * the login above all -- has to survive it.
 *
 * NOTE: these force the whole suite to run serially (--test-concurrency=1 in
 * package.json). TRUNCATE takes an ACCESS EXCLUSIVE lock on all seven tables
 * at once, which deadlocks against any other test file holding rows in those
 * tables -- and every one of them does.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { count, makeLot, one, withRollback } from './helpers.ts'

describe('reset_test_data', () => {
  it('clears products, stock, sales, lots and imports', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'RS-1', items: [['R1', 2, 99900]] })
      await db.query(`insert into sales (product_id, qty, sale_price_cents) values ($1,1,45000)`, [
        lot.productIds[0],
      ])
      await db.query(
        `insert into product_photos (product_id, r2_key) values ($1,'products/x/y')`,
        [lot.productIds[0]],
      )

      const before = await one(db, 'select reset_test_data() as r')
      assert.ok(before.r.products >= 1, 'reports what it removed')

      for (const t of ['products', 'stock_lines', 'sales', 'product_photos', 'lots', 'imports', 'import_rows']) {
        assert.equal(await count(db, `select count(*)::int n from ${t}`), 0, `${t} should be empty`)
      }
    }))

  it('leaves the login and the reference data alone', async () =>
    withRollback(async (db) => {
      await makeLot(db, { code: 'RS-2', items: [['R1', 1, 99900]] })
      const before = {
        profiles: await count(db, 'select count(*)::int n from profiles'),
        categories: await count(db, 'select count(*)::int n from categories'),
        sources: await count(db, 'select count(*)::int n from sources'),
        settings: await count(db, 'select count(*)::int n from settings'),
        category_map: await count(db, 'select count(*)::int n from category_map'),
      }
      assert.ok(before.profiles > 0, 'fixture sanity: there is a login to preserve')

      await db.query('select reset_test_data()')

      for (const [t, n] of Object.entries(before)) {
        assert.equal(await count(db, `select count(*)::int n from ${t}`), n, `${t} must survive`)
      }
    }))

  it('is safe to run twice', async () =>
    withRollback(async (db) => {
      await makeLot(db, { code: 'RS-3', items: [['R1', 1, 99900]] })
      await db.query('select reset_test_data()')
      const second = await one(db, 'select reset_test_data() as r')
      assert.equal(second.r.products, 0, 'a second run reports nothing left to remove')
    }))

  it('is not callable by the public', async () =>
    withRollback(async (db) => {
      await db.query('savepoint p')
      await db.query('set local role anon')
      await assert.rejects(
        () => db.query('select reset_test_data()'),
        /permission denied/i,
        'anon must never be able to wipe the catalogue',
      )
      await db.query('rollback to savepoint p')
      await db.query('reset role')
    }))
})
