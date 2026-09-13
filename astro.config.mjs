// @ts-check

import process from 'node:process'
import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
  // Server-rendered, then cached hard at Cloudflare's edge.
  // See docs/TECHNICAL_PLAN.md §3 for why this beats fully-static here.
  output: 'server',
  adapter: cloudflare({
    imageService: 'compile',
    // Lets bindings marked `"remote": true` in wrangler.jsonc reach the real
    // Cloudflare resource during `astro dev`, instead of a local stand-in.
    remoteBindings: true,
  }),
  integrations: [react()],
  site: process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321',
  vite: { plugins: [tailwindcss()] },
})
