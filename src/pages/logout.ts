/**
 * Sign out.
 *
 * POST only: a link that ends your session is a link a prefetcher, a preview
 * pane or a stray crawler can follow on your behalf.
 */
import type { APIRoute } from 'astro'
import { createSupabaseServerClient } from '../lib/supabase/server.ts'

export const POST: APIRoute = async ({ cookies, request, redirect }) => {
  const supabase = createSupabaseServerClient(cookies, request)
  await supabase.auth.signOut()

  // Belt and braces: whatever the library did or did not clear, no cookie the
  // auth client owns should survive this request. They are chunked when large
  // (…auth-token.0, .1), so every one of them has to go.
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const name = part.split('=')[0]?.trim()
    if (name?.startsWith('sb-')) cookies.delete(name, { path: '/' })
  }

  return redirect('/login?signedout=1', 303)
}
