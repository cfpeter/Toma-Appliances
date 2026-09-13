import type { APIRoute } from 'astro'
import { createPublicClient } from '../lib/supabase/server.ts'

/**
 * Built from the catalogue on request rather than at build time: stock is the
 * thing that changes, and a sitemap frozen at deploy would describe a shop
 * that no longer exists.
 */
export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL('http://localhost:4321')
  const { data } = await createPublicClient()
    .from('catalog')
    .select('slug, published_at, status')
    .limit(5000)

  const urls = [
    { loc: new URL('/', base).toString(), priority: '1.0' },
    { loc: new URL('/appliances', base).toString(), priority: '0.9' },
    { loc: new URL('/about', base).toString(), priority: '0.5' },
    ...(data ?? []).map((p) => ({
      loc: new URL(`/appliances/${p.slug}`, base).toString(),
      lastmod: p.published_at ? new Date(p.published_at).toISOString().slice(0, 10) : undefined,
      // A sold listing keeps its page and its ranking, but stops being the
      // thing we most want crawled.
      priority: p.status === 'sold' ? '0.3' : '0.8',
    })),
  ]

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url><loc>${u.loc}</loc>` +
          ('lastmod' in u && u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : '') +
          `<priority>${u.priority}</priority></url>`,
      )
      .join('\n') +
    '\n</urlset>\n'

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  })
}
