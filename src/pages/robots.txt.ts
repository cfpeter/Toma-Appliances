import type { APIRoute } from 'astro'

/** Admin is behind a login, but there is no reason to invite a crawler in. */
export const GET: APIRoute = ({ site }) =>
  new Response(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /api',
      'Disallow: /login',
      '',
      `Sitemap: ${new URL('/sitemap.xml', site ?? 'http://localhost:4321')}`,
      '',
    ].join('\n'),
    { headers: { 'content-type': 'text/plain; charset=utf-8' } },
  )
