/**
 * Shared pieces of the storefront.
 *
 * The public pages run as `anon`, so everything here goes through views that
 * were written to be safe for that: `catalog` for products, `public_business`
 * for the handful of business fields a customer needs.
 */
import { createPublicClient } from './supabase/server.ts'

export interface Business {
  name: string
  phone: string
  email: string
  hours: string
  area_text: string
  delivery: string
  warranty: string
  about: string
  show_exact_quantity: boolean
  show_sold_items: boolean
}

const FALLBACK: Business = {
  name: 'Toma Appliances',
  phone: '',
  email: '',
  hours: '',
  area_text: '',
  delivery: '',
  warranty: '',
  about: '',
  show_exact_quantity: true,
  show_sold_items: true,
}

export async function getBusiness(): Promise<Business> {
  const { data } = await createPublicClient().from('public_business').select('*').maybeSingle()
  return { ...FALLBACK, ...(data ?? {}) }
}

/**
 * Digits only, with a leading +1 when it looks like a US number.
 *
 * `tel:` and `sms:` are far less forgiving than they look -- brackets and
 * spaces are tolerated by some dialers and silently dropped by others.
 */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (!digits) return ''
  return `+${digits.length === 10 ? '1' : ''}${digits}`
}

/**
 * Characters outside the GSM-7 alphabet force a text into UCS-2, which cuts
 * the per-segment budget from 160 characters to 70 -- so a single curly quote
 * can turn one message into three. The catalogue is full of typographic
 * dashes and quotes, so they are flattened on the way into a message body.
 */
function toPlainText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
}

/**
 * A pre-filled text message. The owner gets a message that already says which
 * appliance it is about, which is the whole reason the listing exists.
 *
 * `?&body=` is not a typo: iOS needs the `&` to read the body, Android is
 * happy either way, and this form works on both.
 */
export function smsHref(phone: string, message: string): string {
  const to = telHref(phone)
  return to ? `sms:${to}?&body=${encodeURIComponent(toPlainText(message))}` : ''
}

/**
 * The message a customer sends about one appliance.
 *
 * The link matters more than it looks: the reply comes back hours later, to
 * someone who has had four other conversations since, and "is this still
 * available?" on its own is unanswerable. A tappable link opens the exact
 * listing, with its price and its stock count.
 */
export function productEnquiry(opts: {
  name: string
  price?: string
  url: string
}): string {
  return [
    'Hi, is this still available?',
    opts.price ? `${opts.name} - ${opts.price}` : opts.name,
    opts.url,
  ].join('\n')
}

/** "1 left" reads as urgency; "2 in stock" reads as choice. Both are true. */
export function stockLabel(qty: number, exact: boolean): string {
  if (qty <= 0) return 'Sold'
  if (!exact) return 'In stock'
  return qty === 1 ? 'Only 1 left' : `${qty} in stock`
}
