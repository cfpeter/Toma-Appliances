/**
 * Photo upload and removal.
 *
 * The browser has already resized the camera file into three WebP versions by
 * the time it gets here (see lib/images/resize.ts), so what arrives is a few
 * hundred kilobytes rather than the four megabytes the phone produced.
 *
 * Guarded by the middleware: /api/admin requires a session.
 */
import type { APIRoute } from 'astro'
// Astro 6 removed `Astro.locals.runtime.env`; bindings come from the Workers
// runtime module now. In dev this is served by platformProxy's local store.
import { env } from 'cloudflare:workers'
import { photoObjectKeys } from '../../../lib/images/keys.ts'

const SIZES = ['thumb', 'card', 'full'] as const

/**
 * What the browser managed to encode. Safari has no WebP encoder, so an
 * iPhone sends JPEG; everything else sends WebP. Anything not on this list --
 * notably PNG, which is what a canvas quietly falls back to -- is refused,
 * because a PNG photograph is an order of magnitude larger for no gain.
 */
const ACCEPTED: Record<string, 'webp' | 'jpeg'> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
}

/** Comfortably above a 1600px photo in either format, well below a PNG one. */
const MAX_BYTES = 3_000_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const POST: APIRoute = async ({ request, locals }) => {
  const bucket = env.PHOTOS
  if (!bucket) {
    return json(
      { error: 'Photo storage is not configured. Check the R2 binding in wrangler.jsonc.' },
      503,
    )
  }
  const supabase = locals.supabase
  if (!supabase) return json({ error: 'Not signed in.' }, 401)

  const form = await request.formData()
  const productId = String(form.get('product_id') ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(productId)) {
    return json({ error: 'A valid product is required.' }, 400)
  }

  // The product must exist and be visible to this user before anything is
  // written to the bucket -- otherwise a bad id leaves objects nothing owns.
  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', productId)
    .maybeSingle()
  if (!product) return json({ error: 'That product no longer exists.' }, 404)

  const parts: { size: string; bytes: ArrayBuffer; type: string }[] = []
  let format: 'webp' | 'jpeg' | null = null
  for (const size of SIZES) {
    const file = form.get(size)
    if (!(file instanceof File)) return json({ error: `Missing the ${size} image.` }, 400)
    const kind = ACCEPTED[file.type]
    if (!kind) {
      return json(
        { error: `Cannot store ${file.type || 'that'} — this browser could not encode WebP or JPEG.` },
        415,
      )
    }
    // All three sizes come off the same canvas, so they always agree.
    if (format && kind !== format) {
      return json({ error: 'The three sizes disagree about their format.' }, 400)
    }
    format = kind
    if (file.size > MAX_BYTES) {
      return json(
        { error: `The ${size} image is ${(file.size / 1_048_576).toFixed(1)} MB, over the ${MAX_BYTES / 1_048_576} MB limit.` },
        413,
      )
    }
    parts.push({ size, bytes: await file.arrayBuffer(), type: file.type })
  }

  const photoId = crypto.randomUUID()
  const stem = `products/${productId}/${photoId}`
  const written: string[] = []

  try {
    for (const { size, bytes, type } of parts) {
      const key = `${stem}-${size}.${format}`
      await bucket.put(key, bytes, {
        httpMetadata: {
          contentType: type,
          // Keys carry a uuid, so an object at a given key never changes.
          cacheControl: 'public, max-age=31536000, immutable',
        },
      })
      written.push(key)
    }

    const { data: last } = await supabase
      .from('product_photos')
      .select('sort_order')
      .eq('product_id', productId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: row, error } = await supabase
      .from('product_photos')
      .insert({
        product_id: productId,
        r2_key: stem,
        format,
        sort_order: (last?.sort_order ?? -1) + 1,
        alt_text: String(form.get('alt') ?? '') || null,
        width: Number(form.get('width')) || null,
        height: Number(form.get('height')) || null,
        bytes: parts.reduce((n, p) => n + p.bytes.byteLength, 0),
      })
      .select('id, r2_key, format, sort_order')
      .single()

    if (error) throw new Error(error.message)
    return json({ photo: row })
  } catch (e) {
    // Never leave objects in the bucket that no row points at: they would be
    // invisible, un-deletable through the UI, and still billed for.
    for (const key of written) {
      try {
        await bucket.delete(key)
      } catch {
        /* best effort */
      }
    }
    return json({ error: e instanceof Error ? e.message : 'Upload failed.' }, 500)
  }
}

export const DELETE: APIRoute = async ({ request, locals }) => {
  const bucket = env.PHOTOS
  const supabase = locals.supabase
  if (!supabase) return json({ error: 'Not signed in.' }, 401)

  const { id } = (await request.json().catch(() => ({}))) as { id?: string }
  if (!id) return json({ error: 'Which photo?' }, 400)

  const { data: photo } = await supabase
    .from('product_photos')
    .select('id, r2_key, format')
    .eq('id', id)
    .maybeSingle()
  if (!photo) return json({ error: 'That photo is already gone.' }, 404)

  // Row first: an orphaned object costs a fraction of a cent, while a row
  // pointing at a deleted object renders as a broken image on the public site.
  const { error } = await supabase.from('product_photos').delete().eq('id', id)
  if (error) return json({ error: error.message }, 500)

  if (bucket) {
    for (const key of photoObjectKeys(photo.r2_key, photo.format)) {
      try {
        await bucket.delete(key)
      } catch {
        /* best effort */
      }
    }
  }
  return json({ ok: true })
}
