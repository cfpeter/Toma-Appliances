/**
 * Condition, in the customer's words.
 *
 * The enum values are B-Stock's vocabulary; these labels are what a buyer
 * reads on the listing. Shared by the admin editor and the public catalog so
 * the two can never drift -- a product that says "Scratch & dent" to the
 * owner must not say "scratch_dent" to a customer.
 *
 * Manifests arrive with coarser grades than this (every row of all three real
 * ones said USED or USED_FAIR), so the owner is expected to correct these by
 * eye once the truck is unloaded. `stock_lines.condition_raw` keeps whatever
 * the manifest originally claimed.
 */
export type Condition = 'new' | 'open_box' | 'scratch_dent' | 'used' | 'for_parts'

export const CONDITIONS: readonly Condition[] = [
  'new',
  'open_box',
  'scratch_dent',
  'used',
  'for_parts',
] as const

const LABELS: Record<Condition, string> = {
  new: 'New',
  open_box: 'Open box',
  scratch_dent: 'Scratch & dent',
  used: 'Used',
  for_parts: 'For parts / not working',
}

/** One line of plain English, for a tooltip or the listing page. */
const NOTES: Record<Condition, string> = {
  new: 'Never used, in the original packaging.',
  open_box: 'Box was opened. The appliance itself is unused.',
  scratch_dent: 'Cosmetic marks only — works as it should.',
  used: 'Previously owned and working. Expect normal wear.',
  for_parts: 'Sold as-is, not working. For repair or parts.',
}

export function conditionLabel(c: string | null | undefined): string {
  return c && c in LABELS ? LABELS[c as Condition] : 'Unspecified'
}

export function conditionNote(c: string | null | undefined): string {
  return c && c in NOTES ? NOTES[c as Condition] : ''
}

/**
 * Tailwind classes for the badge. Scratch & dent and for-parts are called out
 * in amber and red: burying a defect in neutral grey is how a customer drives
 * across Los Angeles and then feels lied to.
 */
export function conditionBadgeClass(c: string | null | undefined): string {
  switch (c) {
    case 'new':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
    case 'open_box':
      return 'bg-sky-50 text-sky-700 ring-sky-600/20'
    case 'scratch_dent':
      return 'bg-amber-50 text-amber-800 ring-amber-600/20'
    case 'for_parts':
      return 'bg-red-50 text-red-700 ring-red-600/20'
    default:
      return 'bg-ink-50 text-ink-700 ring-ink-600/20'
  }
}
