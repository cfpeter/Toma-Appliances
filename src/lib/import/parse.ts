/**
 * Turns a raw B-Stock manifest row into something a customer could read.
 *
 * Manifest descriptions are warehouse shorthand — "SS WF45T6000AW 4.5CUFT" —
 * and cannot go on a public page. This module extracts the model number,
 * capacity and any stated attributes, then rebuilds a proper product name.
 *
 * Everything here is best-effort and every guess is flagged. The admin reviews
 * the result before anything is published; this exists to make that review fast,
 * not to replace it.
 */

import { toCents } from '../money.ts'

/** Description prefix -> brand. Used only when the Brand column is blank. */
export const BRAND_PREFIXES: Record<string, string> = {
  SS: 'Samsung',
  LG: 'LG',
  EL: 'Electrolux',
  MD: 'Midea',
  GE: 'GE',
  HS: 'Hisense',
  WP: 'Whirlpool',
  FR: 'Frigidaire',
  MORA: 'MORA',
}

/** Seller Category -> the singular noun used in a product name. */
export const TYPE_NOUNS: Record<string, string> = {
  Washers: 'Washer',
  Dryers: 'Dryer',
  Refrigerators: 'Refrigerator',
  Freezers: 'Freezer',
  Ranges: 'Range',
  Cooktops: 'Cooktop',
  Dishwashers: 'Dishwasher',
  Microwaves: 'Microwave',
  'Laundry Suites': 'Laundry Center',
}

/** Words that look like models but aren't. */
const NOT_A_MODEL = new Set([
  'CUFT',
  'CF',
  'CU',
  'FT',
  'GAS',
  'ELEC',
  'ELE',
  'ELECTRIC',
  'STAINLESS',
  'BLKST',
  'WHT',
  'BLK',
  'FL',
  'TOP',
  'LOAD',
  'PEDESTAL',
  'STACK',
  'KIT',
  'WASHER',
  'DRYER',
  'FRZ',
  'REF',
  'AIO',
  'BESPOKE',
  'TWR',
  'CONTROL',
])

export interface ParsedRow {
  rowNumber: number
  raw: Record<string, string>
  itemNo: string | null
  upc: string | null
  brand: string | null
  model: string | null
  description: string
  name: string
  qty: number | null
  unitRetailCents: number | null
  sourceCategory: string | null
  sourceSellerCategory: string | null
  conditionRaw: string | null
  flags: string[]
}

/**
 * Pull the model number out of a description.
 * A model is an uppercase token starting with letters, containing a digit,
 * at least 5 characters long — "WF45T6000AW", "SKK-8K", "STACKIT7X".
 */
export function extractModel(description: string): string | null {
  const tokens = description.toUpperCase().split(/[\s,]+/)
  for (const token of tokens) {
    const t = token.replace(/^[^A-Z0-9]+|[^A-Z0-9-]+$/g, '')
    if (t.length < 5) continue
    if (NOT_A_MODEL.has(t)) continue
    if (!/^[A-Z]{2,}/.test(t)) continue // must start with letters
    if (!/\d/.test(t)) continue //          must contain a digit
    if (!/^[A-Z0-9-]+$/.test(t)) continue
    return t
  }
  return null
}

/** "4.5CUFT" | "7.5 CU. FT" | "23 CF" -> "4.5 cu. ft." */
export function extractCapacity(description: string): string | null {
  const m = description.toUpperCase().match(/(\d+(?:\.\d+)?)\s*(?:CU\.?\s*FT|CUFT|CU\s*FT|CF)\b/)
  return m ? `${Number.parseFloat(m[1])} cu. ft.` : null
}

/** Attributes the description states outright. Never inferred from a model number. */
export function extractAttributes(description: string): string[] {
  const d = ` ${description.toUpperCase()} `
  const attrs: string[] = []
  if (/\bFL\b|\bFRONT\s*LOAD\b/.test(d)) attrs.push('Front Load')
  if (/\bTOP\s*LOAD\b/.test(d)) attrs.push('Top Load')
  if (/\bGAS\b|\bGA\b/.test(d)) attrs.push('Gas')
  else if (/\bELEC\b|\bELECTRIC\b|\bELE\b/.test(d)) attrs.push('Electric')
  return attrs
}

/** Brand column first; then the description prefix; then the vendor name. */
export function resolveBrand(row: Record<string, string>): {
  brand: string | null
  guessed: boolean
} {
  const stated = (row.Brand ?? '').trim()
  if (stated) return { brand: stated, guessed: false }

  const prefix = (row['Item Description'] ?? '').trim().split(/\s+/)[0]?.toUpperCase()
  if (prefix && BRAND_PREFIXES[prefix]) return { brand: BRAND_PREFIXES[prefix], guessed: true }

  const vendor = (row.Vendor ?? '').trim()
  if (vendor) {
    const word = vendor.split(/\s+/)[0]
    if (word.length > 2) {
      return { brand: word.charAt(0) + word.slice(1).toLowerCase(), guessed: true }
    }
  }
  return { brand: null, guessed: false }
}

/** Accessories hide under the "Appliances" seller category. Detect them by name. */
export function detectAccessory(description: string): string | null {
  const d = description.toUpperCase()
  // Manifests truncate descriptions mid-word, so match on stems:
  // "LAUNDRY PEDEST", "STACKING KIT", "STACK KIT", "STACKIT7X", "SKK-8K".
  if (/PEDEST/.test(d)) return 'Pedestal'
  if (/STACK(?:ING)?\s*KIT|STACKIT|\bSKK\b|\bKSTK/.test(d)) return 'Stacking Kit'
  return null
}

/** Product types stated in the description that no seller category covers. */
export function detectSpecialType(description: string): string | null {
  const d = description.toUpperCase()
  // All-in-one washer/dryer — a single drum that does both.
  if (/\bAIO\b|ALL[\s-]?IN[\s-]?ONE/.test(d)) return 'All-in-One Washer Dryer'
  return null
}

/** Assemble a customer-facing product name. */
export function buildName(parts: {
  brand: string | null
  capacity: string | null
  attributes: string[]
  typeNoun: string | null
  model: string | null
  fallback: string
}): string {
  const { brand, capacity, attributes, typeNoun, model, fallback } = parts
  if (!typeNoun && !brand) return fallback

  const words = [brand, capacity, ...attributes, typeNoun].filter(Boolean)
  const base = words.join(' ').trim()
  if (!base) return fallback
  return model ? `${base} (${model})` : base
}

export function parseRow(row: Record<string, string>, rowNumber: number): ParsedRow {
  const flags: string[] = []
  const description = (row['Item Description'] ?? '').trim()

  // Some descriptions carry a leading "@" marker whose meaning B-Stock does not
  // document. It appears across brands and lots. Stripped from the display name,
  // preserved intact in `raw`.
  const cleanDesc = description.replace(/\s@\s/g, ' ').replace(/\s+/g, ' ').trim()

  const model = extractModel(cleanDesc)
  if (!model) flags.push('no_model')

  const { brand, guessed } = resolveBrand(row)
  if (!brand) flags.push('no_brand')
  else if (guessed) flags.push('brand_guessed')

  const sellerCategory = (row['Seller Category'] ?? '').trim() || null
  const accessory = detectAccessory(cleanDesc)
  const special = detectSpecialType(cleanDesc)
  const typeNoun =
    accessory ?? special ?? (sellerCategory ? (TYPE_NOUNS[sellerCategory] ?? null) : null)
  if (!typeNoun) flags.push('unknown_type')
  if (accessory) flags.push('accessory')

  const qtyRaw = Number.parseInt(row.Qty ?? '', 10)
  const qty = Number.isFinite(qtyRaw) ? qtyRaw : null
  if (!qty || qty < 1) flags.push('bad_qty')

  const unitRetailCents = toCents(row['Unit Retail'])
  if (!unitRetailCents) flags.push('no_msrp')

  // Ext. Retail should equal Qty x Unit Retail. When it doesn't, the row is
  // suspect and the reviewer should look at it.
  const extRetailCents = toCents(row['Ext. Retail'])
  if (qty && unitRetailCents && extRetailCents) {
    if (Math.abs(qty * unitRetailCents - extRetailCents) > 2) flags.push('retail_mismatch')
  }

  // UPCs arrive with a trailing comma and can hold several values.
  const upc =
    (row.UPC ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)[0] ?? null

  return {
    rowNumber,
    raw: row,
    itemNo: (row['Item #'] ?? '').trim() || null,
    upc,
    brand,
    model,
    description: cleanDesc,
    name: buildName({
      brand,
      capacity: extractCapacity(cleanDesc),
      attributes: accessory ? [] : extractAttributes(cleanDesc),
      typeNoun,
      model,
      fallback: cleanDesc,
    }),
    qty,
    unitRetailCents,
    sourceCategory: (row.Category ?? '').trim() || null,
    sourceSellerCategory: sellerCategory,
    conditionRaw: (row.Condition ?? '').trim() || null,
    flags,
  }
}
