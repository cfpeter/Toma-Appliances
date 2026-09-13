/**
 * Serve a photo out of the R2 binding.
 *
 * A stopgap with a long life: it works in local development and on a fresh
 * deploy with no custom domain. Once the bucket is bound to
 * img.tomaappliances.com, PUBLIC_IMAGE_BASE_URL points there instead and this
 * route stops being asked for anything. Responses are immutable and cached at
 * the edge either way, so the Worker is not in the hot path for long.
 */
import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

export const prerender = false

export const GET: APIRoute = async ({ params, request }) => {
  const bucket = env.PHOTOS
  const key = params.key
  if (!bucket || !key) return new Response('Not found', { status: 404 })

  const object = await bucket.get(key)
  if (!object) return new Response('Not found', { status: 404 })

  // Keys are uuid-based and never reused, so a matching etag is always fresh.
  const etag = object.httpEtag
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } })
  }

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      etag,
    },
  })
}
