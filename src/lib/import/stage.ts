/**
 * Stage a manifest for review.
 *
 * Shared by the browser upload and the CLI script so both behave identically.
 * Nothing here publishes anything — it only fills the staging tables.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCsv } from './csv.ts'
import { parseRow } from './parse.ts'

export interface StageResult {
  importId: string
  lotId: string
  lotCode: string
  rows: number
  units: number
  retailCents: number
  created: number
  matched: number
  skipped: number
  flagged: number
}

export async function stageManifest(
  supabase: SupabaseClient,
  csvText: string,
  filename: string,
): Promise<StageResult> {
  const rows = parseCsv(csvText).map(parseRow)
  if (rows.length === 0) throw new Error('No rows found in that file.')

  // Sanity-check it's actually a B-Stock manifest before writing anything.
  const header = Object.keys(rows[0].raw)
  for (const required of ['Item Description', 'Qty', 'Unit Retail']) {
    if (!header.includes(required)) {
      throw new Error(
        `This doesn't look like a B-Stock manifest — no "${required}" column. Found: ${header.slice(0, 6).join(', ')}`,
      )
    }
  }

  const lotCode = rows[0].raw['Lot ID']?.trim() || filename.replace(/\.csv$/i, '')
  const vendor = rows[0].raw.Vendor?.trim() || null

  const { data: source } = await supabase.from('sources').select('id').eq('code', 'bstock').single()
  const { data: mappings } = await supabase
    .from('category_map')
    .select('source_category, source_seller_category, category_id')
  const categoryFor = (cat: string | null, seller: string | null) =>
    mappings?.find((m) => m.source_category === cat && m.source_seller_category === seller)
      ?.category_id ?? null

  const { data: existing } = await supabase
    .from('products')
    .select('id, item_no')
    .not('item_no', 'is', null)
  const byItemNo = new Map((existing ?? []).map((p) => [p.item_no, p.id]))

  // Reuse the lot if this manifest was staged before, so re-uploading is safe.
  let { data: lot } = await supabase.from('lots').select('id').eq('lot_code', lotCode).maybeSingle()
  if (!lot) {
    const { data, error } = await supabase
      .from('lots')
      .insert({
        source_id: source?.id,
        lot_code: lotCode,
        vendor,
        purchase_date: new Date().toISOString().slice(0, 10),
      })
      .select('id')
      .single()
    if (error) throw new Error(`Could not create the lot: ${error.message}`)
    lot = data
  }

  // Replace any earlier *pending* staging for this lot. Committed imports are
  // left alone — undoing one is a deliberate, separate action.
  await supabase.from('imports').delete().eq('lot_id', lot.id).eq('status', 'pending')

  const { data: imp, error: impError } = await supabase
    .from('imports')
    .insert({
      lot_id: lot.id,
      source_id: source?.id,
      filename,
      row_count: rows.length,
      status: 'pending',
    })
    .select('id')
    .single()
  if (impError) throw new Error(`Could not create the import: ${impError.message}`)

  const seen = new Set<string>()
  let created = 0
  let matched = 0
  let skipped = 0
  let flagged = 0

  const payload = rows.map((r) => {
    const flags = [...r.flags]
    const categoryId = categoryFor(r.sourceCategory, r.sourceSellerCategory)
    if (!categoryId) flags.push('unmapped_category')
    if (r.itemNo && seen.has(r.itemNo)) flags.push('duplicate_in_file')
    if (r.itemNo) seen.add(r.itemNo)

    const matchId = r.itemNo ? (byItemNo.get(r.itemNo) ?? null) : null
    // Accessories default to skip — a $32 stack kit isn't worth a product page.
    const action = flags.includes('accessory') ? 'skip' : matchId ? 'match' : 'new'
    if (action === 'new') created++
    else if (action === 'match') matched++
    else skipped++
    if (flags.length > 0) flagged++

    return {
      import_id: imp.id,
      row_number: r.rowNumber,
      raw: r.raw,
      item_no: r.itemNo,
      upc: r.upc,
      brand: r.brand,
      model: r.model,
      description: r.name,
      qty: r.qty,
      unit_retail_cents: r.unitRetailCents,
      source_category: r.sourceCategory,
      source_seller_category: r.sourceSellerCategory,
      condition_raw: r.conditionRaw,
      action,
      matched_product_id: matchId,
      flags,
      category_id: categoryId,
    }
  })

  const { error: rowsError } = await supabase.from('import_rows').insert(payload)
  if (rowsError) {
    await supabase.from('imports').delete().eq('id', imp.id)
    throw new Error(`Could not stage the rows: ${rowsError.message}`)
  }

  return {
    importId: imp.id,
    lotId: lot.id,
    lotCode,
    rows: rows.length,
    units: rows.reduce((s, r) => s + (r.qty ?? 0), 0),
    retailCents: rows.reduce((s, r) => s + (r.qty ?? 0) * (r.unitRetailCents ?? 0), 0),
    created,
    matched,
    skipped,
    flagged,
  }
}
