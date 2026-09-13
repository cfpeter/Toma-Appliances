import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { count, makeLot, one, withRollback } from './helpers.ts'

describe('delete_lot', () => {
  it('removes the lot, its stock and its orphaned products', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, {
        code: 'DEL-1',
        items: [
          ['D1', 2, 100000],
          ['D2', 3, 200000],
        ],
      })

      assert.equal(
        await count(db, 'select count(*)::int n from stock_lines where lot_id=$1', [lot.lotId]),
        2,
      )

      const r = await one(db, 'select delete_lot($1) r', [lot.lotId])
      assert.equal(r.r.units_removed, 5)
      assert.equal(r.r.products_removed, 2)

      assert.equal(await count(db, 'select count(*)::int n from lots where id=$1', [lot.lotId]), 0)
      assert.equal(
        await count(db, 'select count(*)::int n from stock_lines where lot_id=$1', [lot.lotId]),
        0,
      )
      assert.equal(
        await count(db, 'select count(*)::int n from imports where lot_id=$1', [lot.lotId]),
        0,
      )
    })
  })

  it('cascades import_rows away with the import', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'DEL-2', items: [['D3', 1, 50000]] })
      assert.equal(
        await count(db, 'select count(*)::int n from import_rows where import_id=$1', [
          lot.importId,
        ]),
        1,
      )
      await db.query('select delete_lot($1)', [lot.lotId])
      assert.equal(
        await count(db, 'select count(*)::int n from import_rows where import_id=$1', [
          lot.importId,
        ]),
        0,
      )
    })
  })

  it('KEEPS a product that also holds stock from another lot, reducing its quantity', async () => {
    await withRollback(async (db) => {
      const first = await makeLot(db, { code: 'DEL-3a', items: [['SHARED', 4, 100000]] })
      // Same item number, so the second lot matches onto the same product.
      const second = await makeLot(db, { code: 'DEL-3b', items: [['SHARED', 3, 100000, 'match']] })

      const productId = first.productIds[0]
      const qtyBefore = await count(
        db,
        'select coalesce(sum(qty_received),0)::int n from stock_lines where product_id=$1',
        [productId],
      )
      assert.equal(qtyBefore, 7, 'both lots should stock the same product')

      await db.query('select delete_lot($1)', [second.lotId])

      assert.equal(
        await count(db, 'select count(*)::int n from products where id=$1', [productId]),
        1,
        'shared product must survive',
      )
      assert.equal(
        await count(
          db,
          'select coalesce(sum(qty_received),0)::int n from stock_lines where product_id=$1',
          [productId],
        ),
        4,
        'quantity should drop to what the surviving lot holds',
      )
    })
  })

  it('REFUSES to delete a lot that has sales', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'DEL-4', items: [['D4', 2, 100000]] })
      await db.query('insert into sales (product_id, qty, sale_price_cents) values ($1,1,50000)', [
        lot.productIds[0],
      ])

      await assert.rejects(
        () => db.query('select delete_lot($1)', [lot.lotId]),
        /sale\(s\) against it/,
        'deleting a lot with revenue against it must fail',
      )
    })
  })

  it('force-deletes a lot with sales, removing those sales too', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'DEL-5', items: [['D5', 2, 100000]] })
      await db.query('insert into sales (product_id, qty, sale_price_cents) values ($1,1,50000)', [
        lot.productIds[0],
      ])

      const r = await one(db, 'select delete_lot($1, true) r', [lot.lotId])
      assert.equal(r.r.sales_removed, 1)
      assert.equal(await count(db, 'select count(*)::int n from lots where id=$1', [lot.lotId]), 0)
      assert.equal(
        await count(db, 'select count(*)::int n from sales where product_id=$1', [
          lot.productIds[0],
        ]),
        0,
      )
    })
  })

  it('force-delete keeps a sold product that still has stock from another lot', async () => {
    await withRollback(async (db) => {
      const first = await makeLot(db, { code: 'DEL-6a', items: [['SH2', 4, 100000]] })
      const second = await makeLot(db, { code: 'DEL-6b', items: [['SH2', 3, 100000, 'match']] })
      const productId = first.productIds[0]
      await db.query('insert into sales (product_id, qty, sale_price_cents) values ($1,1,50000)', [
        productId,
      ])

      await db.query('select delete_lot($1, true)', [second.lotId])

      assert.equal(
        await count(db, 'select count(*)::int n from products where id=$1', [productId]),
        1,
      )
      assert.equal(
        await count(db, 'select count(*)::int n from sales where product_id=$1', [productId]),
        1,
        'the sale belongs to stock from the surviving lot and must not be destroyed',
      )
    })
  })

  it('raises for a lot that does not exist', async () => {
    await withRollback(async (db) => {
      await assert.rejects(
        () => db.query(`select delete_lot('00000000-0000-0000-0000-000000000000')`),
        /not found/,
      )
    })
  })
})

describe('lot_delete_preview', () => {
  it('reports units, removals and shared survivors accurately', async () => {
    await withRollback(async (db) => {
      // The first lot exists only to give P1 a second home, so the preview has
      // something to report as "kept".
      await makeLot(db, {
        code: 'PRE-1a',
        items: [
          ['P1', 2, 100000],
          ['P2', 1, 100000],
        ],
      })
      const second = await makeLot(db, {
        code: 'PRE-1b',
        items: [
          ['P1', 5, 100000, 'match'],
          ['P3', 4, 100000],
        ],
      })

      const { p } = await one(db, 'select lot_delete_preview($1) p', [second.lotId])
      assert.equal(p.units, 9, '5 matched + 4 new')
      assert.equal(p.products_removed, 1, 'only P3 is exclusive to this lot')
      assert.equal(p.products_kept, 1, 'P1 is shared with the first lot')
      assert.equal(p.sales, 0)

      // The preview must agree with what deletion actually does.
      const r = await one(db, 'select delete_lot($1) r', [second.lotId])
      assert.equal(r.r.units_removed, p.units)
      assert.equal(r.r.products_removed, p.products_removed)
    })
  })

  it('counts sales that would block deletion', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'PRE-2', items: [['P4', 3, 100000]] })
      await db.query('insert into sales (product_id, qty, sale_price_cents) values ($1,1,10000)', [
        lot.productIds[0],
      ])
      const { p } = await one(db, 'select lot_delete_preview($1) p', [lot.lotId])
      assert.equal(p.sales, 1)
    })
  })
})

describe('archive_lot', () => {
  it('archives and un-archives without touching stock', async () => {
    await withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'ARC-1', items: [['A1', 3, 100000]] })

      await db.query('select archive_lot($1)', [lot.lotId])
      let row = await one(db, 'select archived_at from lots where id=$1', [lot.lotId])
      assert.ok(row.archived_at, 'archived_at should be set')
      assert.equal(
        await count(
          db,
          'select coalesce(sum(qty_received),0)::int n from stock_lines where lot_id=$1',
          [lot.lotId],
        ),
        3,
        'archiving must not remove stock',
      )

      await db.query('select archive_lot($1, false)', [lot.lotId])
      row = await one(db, 'select archived_at from lots where id=$1', [lot.lotId])
      assert.equal(row.archived_at, null)
    })
  })
})
