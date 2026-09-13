/**
 * All money in this system is INTEGER CENTS. Never floats.
 *
 * Cost allocation divides a truckload's lump-sum price across dozens of units,
 * which is exactly where floating-point money drifts and profit reports quietly
 * start lying.
 */

/** "719.99" | "$1,149.99" -> 71999 | 114999. Returns null if unparseable. */
export function toCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null
  const cleaned = value.replace(/[$,\s]/g, '').trim()
  if (!cleaned) return null
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/** 71999 -> "$719.99" */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * Round a suggested price to a psychological price point.
 * step 900 => always ends in .99 at the nearest whole dollar below.
 */
export function roundToPricePoint(cents: number, step = 900): number {
  if (step <= 0) return cents
  const base = Math.floor(cents / 10000) * 10000
  const candidate = base + step
  return candidate >= cents - 5000 ? candidate : candidate + 10000
}
