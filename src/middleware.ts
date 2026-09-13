import { defineMiddleware } from 'astro:middleware'
import { createSupabaseServerClient } from './lib/supabase/server.ts'

/**
 * Everything under /admin and /api/admin requires a session, and none of it is
 * ever cached. The API prefix matters as much as the page one: those endpoints
 * write to storage and to the database, so leaving them outside the guard
 * would put an open upload behind a URL nobody happened to have guessed yet.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url

  // One canonical hostname. Both www and the apex resolve to this Worker, and
  // leaving both live would have Google index the site twice and split its
  // ranking between them -- the opposite of the point.
  const host = context.url.hostname
  if (host.startsWith('www.')) {
    const target = new URL(context.url)
    target.hostname = host.slice(4)
    return context.redirect(target.toString(), 301)
  }

  const isApi = pathname.startsWith('/api/admin')

  if (isApi || pathname.startsWith('/admin')) {
    const supabase = createSupabaseServerClient(context.cookies, context.request)
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      // A redirect to a login page is a confusing answer to fetch().
      return isApi
        ? new Response(JSON.stringify({ error: 'Not signed in.' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        : context.redirect(`/login?next=${encodeURIComponent(pathname)}`, 302)
    }
    context.locals.user = user
    context.locals.supabase = supabase

    const response = await next()
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }

  return next()
})
