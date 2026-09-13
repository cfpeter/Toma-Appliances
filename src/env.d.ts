/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user?: import('@supabase/supabase-js').User
    supabase?: import('@supabase/supabase-js').SupabaseClient
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string
  readonly PUBLIC_SUPABASE_PUBLISHABLE_KEY: string
  readonly SUPABASE_SECRET_KEY: string
  readonly PUBLIC_SITE_URL: string
  readonly PUBLIC_IMAGE_BASE_URL: string
  /** '1' while testing: shows the reset control in the admin. */
  readonly ALLOW_DATA_RESET: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
