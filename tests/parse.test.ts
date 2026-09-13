import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseCsv } from '../src/lib/import/csv.ts'
import {
  detectAccessory,
  extractCapacity,
  extractModel,
  parseRow,
  resolveBrand,
} from '../src/lib/import/parse.ts'
import { formatCents, toCents } from '../src/lib/money.ts'

describe('money', () => {
  it('parses to integer cents', () => {
    assert.equal(toCents('719.99'), 71999)
    assert.equal(toCents('$1,149.99'), 114999)
    assert.equal(toCents('0'), 0)
    assert.equal(toCents(''), null)
    assert.equal(toCents(null), null)
    assert.equal(toCents('not a number'), null)
  })

  it('never loses a cent to floating point', () => {
    // 0.1 + 0.2 style drift is exactly what integer cents exist to prevent.
    let total = 0
    for (let i = 0; i < 100; i++) total += toCents('0.07')!
    assert.equal(total, 700)
  })

  it('formats for display', () => {
    assert.equal(formatCents(71999), '$719.99')
    assert.equal(formatCents(0), '$0.00')
    assert.equal(formatCents(null), '—')
  })
})

describe('extractModel', () => {
  it('pulls the model out of warehouse shorthand', () => {
    assert.equal(extractModel('SS WF45T6000AW 4.5CUFT'), 'WF45T6000AW')
    assert.equal(extractModel('LG DLEX8980V 9.0CF ELEC'), 'DLEX8980V')
    assert.equal(extractModel('SS 27" STACK KIT SKK-8K'), 'SKK-8K')
    assert.equal(extractModel('EL STACKIT7X 27"'), 'STACKIT7X')
  })

  it('does not mistake units or colours for a model', () => {
    assert.equal(extractModel('SS 4.5CUFT'), null)
    assert.equal(extractModel('WASHER STAINLESS'), null)
  })
})

describe('extractCapacity', () => {
  it('normalises every spelling seen in real manifests', () => {
    assert.equal(extractCapacity('SS WF45T6000AW 4.5CUFT'), '4.5 cu. ft.')
    assert.equal(extractCapacity('SS DVG45T6000V 7.5 CU. FT'), '7.5 cu. ft.')
    assert.equal(extractCapacity('SS RF23BB8600QL 23 CF BES'), '23 cu. ft.')
    assert.equal(extractCapacity('MD MRF27I6BST 27 CU. FT.'), '27 cu. ft.')
    assert.equal(extractCapacity('LG DLEX8980V 9.0CF ELEC'), '9 cu. ft.')
    assert.equal(extractCapacity('SS WE402NW'), null)
  })
})

describe('resolveBrand', () => {
  it('uses the Brand column when present', () => {
    const r = resolveBrand({ Brand: 'Samsung', 'Item Description': 'SS X', Vendor: 'V' })
    assert.deepEqual(r, { brand: 'Samsung', guessed: false })
  })

  it('falls back to the description prefix when Brand is blank', () => {
    // 6 Electrolux rows in the real BRI manifest have no Brand.
    const r = resolveBrand({
      Brand: '',
      'Item Description': 'EL FFUE2024AW FRZ',
      Vendor: 'ELECTROLUX',
    })
    assert.equal(r.brand, 'Electrolux')
    assert.equal(r.guessed, true, 'a guess must be flagged for review')
  })

  it('falls back to the vendor when nothing else is available', () => {
    const r = resolveBrand({ Brand: '', 'Item Description': 'ZZ 12345', Vendor: 'WHIRLPOOL CORP' })
    assert.equal(r.brand, 'Whirlpool')
    assert.equal(r.guessed, true)
  })
})

describe('detectAccessory', () => {
  it('catches truncated descriptions', () => {
    assert.equal(detectAccessory('SS WE502NV LAUNDRY PEDEST'), 'Pedestal')
    assert.equal(detectAccessory('LG KSTK4 27" STACKING KIT'), 'Stacking Kit')
    assert.equal(detectAccessory('SS 27" STACK KIT SKK-8K'), 'Stacking Kit')
    assert.equal(detectAccessory('SS WF45T6000AW 4.5CUFT'), null)
  })
})

describe('parseRow', () => {
  const row = (over: Record<string, string> = {}) => ({
    'Lot ID': 'X-1',
    'Item Description': 'SS WF45T6000AW 4.5CUFT',
    Qty: '5',
    'Unit Retail': '719.99',
    'Ext. Retail': '3599.95',
    'Item #': '1446987',
    UPC: '499996773973,',
    Vendor: 'SAMSUNG ELECTRONICS AMERI',
    Brand: 'Samsung',
    Category: 'LAUNDRY_APPLIANCES',
    'Seller Category': 'Washers',
    Condition: 'USED',
    'Notes/Comments': '',
    'Pallet ID': 'X-1',
    ...over,
  })

  it('builds a customer-facing name', () => {
    const r = parseRow(row(), 0)
    assert.equal(r.name, 'Samsung 4.5 cu. ft. Washer (WF45T6000AW)')
    assert.equal(r.model, 'WF45T6000AW')
    assert.equal(r.unitRetailCents, 71999)
    assert.deepEqual(r.flags, [])
  })

  it('strips the trailing comma from a UPC', () => {
    assert.equal(parseRow(row(), 0).upc, '499996773973')
  })

  it('strips the undocumented @ marker from the display name', () => {
    const r = parseRow(row({ 'Item Description': 'SS @ WA55A7300AE WASHER' }), 0)
    assert.ok(!r.name.includes('@'), 'the @ must not reach a customer')
    assert.equal(r.raw['Item Description'], 'SS @ WA55A7300AE WASHER', 'raw is preserved verbatim')
  })

  it('flags a row whose Ext. Retail does not equal qty x unit retail', () => {
    const r = parseRow(row({ 'Ext. Retail': '9999.99' }), 0)
    assert.ok(r.flags.includes('retail_mismatch'))
  })

  it('flags missing model, brand and MSRP', () => {
    const r = parseRow(
      row({ 'Item Description': 'MYSTERY', Brand: '', Vendor: '', 'Unit Retail': '' }),
      0,
    )
    assert.ok(r.flags.includes('no_model'))
    assert.ok(r.flags.includes('no_brand'))
    assert.ok(r.flags.includes('no_msrp'))
  })
})

describe('parseCsv against the real manifests', () => {
  const files = readdirSync('samples').filter((f) => f.endsWith('.csv'))

  it('finds sample manifests to test against', () => {
    assert.ok(files.length > 0, 'samples/ should contain real B-Stock manifests')
  })

  for (const file of files) {
    it(`parses ${file} with the expected columns`, () => {
      const rows = parseCsv(readFileSync(`samples/${file}`, 'utf8'))
      assert.ok(rows.length > 0)
      for (const required of ['Item Description', 'Qty', 'Unit Retail', 'Item #']) {
        assert.ok(required in rows[0], `missing column: ${required}`)
      }
    })

    it(`${file}: Ext. Retail reconciles to qty x unit retail`, () => {
      // This is what proves Unit Retail is MSRP and not what was paid.
      const rows = parseCsv(readFileSync(`samples/${file}`, 'utf8'))
      for (const r of rows) {
        const qty = Number.parseInt(r.Qty, 10)
        const unit = toCents(r['Unit Retail'])!
        const ext = toCents(r['Ext. Retail'])!
        assert.ok(Math.abs(qty * unit - ext) <= 2, `row mismatch: ${r['Item Description']}`)
      }
    })
  }
})
