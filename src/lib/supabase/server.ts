import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { AstroCookies } from 'astro'

const url = import.meta.env.PUBLIC_SUPABASE_URL
const publishable = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY

/**
 * Request-scoped client that carries the signed-in user's session.
 * Row Level Security applies — this is what admin pages should use.
 */
export function createSupabaseServerClient(cookies: AstroCookies, request: Request) {
  return createServerClient(url, publishable, {
    cookies: {
      // AstroCookies has no getAll(), so read the request header directly.
      getAll: () => parseCookieHeader(request.headers.get('cookie') ?? ''),
      setAll: (list) => {
        for (const { name, value, options } of list) {
          cookies.set(name, value, { ...options, path: '/' })
        }
      },
    },
  })
}

/** "a=1; b=2" -> [{ name: 'a', value: '1' }, ...] */
function parseCookieHeader(header: string): { name: string; value: string }[] {
  if (!header) return []
  return header
    .split(';')
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq < 0) return null
      const name = part.slice(0, eq).trim()
      if (!name) return null
      return { name, value: decodeURIComponent(part.slice(eq + 1).trim()) }
    })
    .filter((c): c is { name: string; value: string } => c !== null)
}

/**
 * Anonymous client for the public catalog. Sees only what RLS and the column
 * grants allow — no costs, no MSRP, no condition.
 */
export function createPublicClient() {
  return createClient(url, publishable, { auth: { persistSession: false } })
}

/*
 * There is deliberately no service-role client here.
 *
 * One existed and was never called. A client that bypasses every row and
 * column policy is not worth keeping on the chance it becomes useful: the day
 * someone reaches for it in a hurry is exactly the day RLS stops protecting
 * anything.
 *
 * Every request acts as the signed-in user instead. If a job ever genuinely
 * has to act as the system, add it back deliberately -- `import.meta.env`
 * reads `SUPABASE_SECRET_KEY` from the Worker environment at runtime rather
 * than baking it into the bundle (verified against a production build), so
 * `wrangler secret put SUPABASE_SECRET_KEY` is all it needs.
 */
