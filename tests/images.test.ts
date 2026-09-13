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
import { SIZES, fit, readImageSize } from '../src/lib/images/resize.ts'

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

describe('readImageSize', () => {
  /** Minimal File shim: the parser only ever calls slice().arrayBuffer(). */
  const asFile = (bytes: number[]): File =>
    ({
      slice: () => ({ arrayBuffer: async () => new Uint8Array(bytes).buffer }),
    }) as unknown as File

  it('reads a JPEG SOF0 marker', async () => {
    // SOI, an APP0 segment to skip over, then SOF0 carrying 6048 x 8064
    const bytes = [
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x17, 0xa0, 0x1f, 0x80,
      ...new Array(16).fill(0),
    ]
    assert.deepEqual(await readImageSize(asFile(bytes)), { width: 8064, height: 6048 })
  })

  it('skips segments rather than reading the first thing that looks right', async () => {
    // A comment segment whose payload contains bytes resembling a SOF marker.
    const bytes = [
      0xff, 0xd8,
      0xff, 0xfe, 0x00, 0x06, 0xff, 0xc0, 0x00, 0x11,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x06, 0x40,
      ...new Array(16).fill(0),
    ]
    assert.deepEqual(await readImageSize(asFile(bytes)), { width: 1600, height: 1200 })
  })

  it('reads a PNG IHDR', async () => {
    const bytes = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x00, 0xc8,
      ...new Array(8).fill(0),
    ]
    assert.deepEqual(await readImageSize(asFile(bytes)), { width: 300, height: 200 })
  })

  it('returns null for something it does not recognise', async () => {
    assert.equal(await readImageSize(asFile(new Array(64).fill(0x41))), null)
  })

  it('returns null rather than hanging on a truncated file', async () => {
    assert.equal(await readImageSize(asFile([0xff, 0xd8, 0xff])), null)
  })
})
