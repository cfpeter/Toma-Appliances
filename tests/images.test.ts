/**
 * Resize arithmetic.
 *
 * `renderSizes` itself needs a browser (canvas, createImageBitmap), but the
 * sizing decision is pure, and it is the part that silently ruins a listing:
 * a wrong aspect ratio makes every appliance look stretched, and upscaling a
 * small image makes it look worse than leaving it alone.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SIZES, fit } from '../src/lib/images/resize.ts'

describe('fit', () => {
  it('caps the longest edge and keeps the ratio, landscape', () => {
    // A typical phone photo, 4:3.
    assert.deepEqual(fit(4032, 3024, 800), { width: 800, height: 600 })
  })

  it('caps the longest edge and keeps the ratio, portrait', () => {
    // Same camera turned sideways: height is what must be capped.
    assert.deepEqual(fit(3024, 4032, 800), { width: 600, height: 800 })
  })

  it('never upscales', () => {
    const small = fit(320, 240, 1600)
    assert.deepEqual(small, { width: 320, height: 240 }, 'a small image is left alone')
  })

  it('leaves an exactly-sized image untouched', () => {
    assert.deepEqual(fit(800, 450, 800), { width: 800, height: 450 })
  })

  it('handles a square', () => {
    assert.deepEqual(fit(2000, 2000, 400), { width: 400, height: 400 })
  })

  it('keeps a panorama from collapsing to nothing', () => {
    const r = fit(8000, 400, 400)
    assert.equal(r.width, 400)
    assert.ok(r.height >= 1, 'a degenerate height would fail to encode')
  })

  it('rounds to whole pixels', () => {
    const r = fit(1001, 667, 400)
    assert.equal(r.width, Math.round(r.width))
    assert.equal(r.height, Math.round(r.height))
  })
})

describe('SIZES', () => {
  it('orders the three sizes smallest to largest', () => {
    assert.ok(SIZES.thumb.edge < SIZES.card.edge)
    assert.ok(SIZES.card.edge < SIZES.full.edge)
  })

  it('keeps quality in a sane band', () => {
    for (const [name, s] of Object.entries(SIZES)) {
      assert.ok(s.quality > 0.5 && s.quality <= 0.9, `${name} quality is unreasonable`)
    }
  })
})
