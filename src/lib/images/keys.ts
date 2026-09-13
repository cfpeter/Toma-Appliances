/**
 * One photo is three objects in the bucket. The database stores the stem --
 * `products/<product>/<photo>` -- and the size is appended when a URL is
 * built, so a row never has to list three near-identical strings.
 */
import type { PhotoFormat, PhotoSize } from './resize.ts'

/**
 * `PUBLIC_IMAGE_BASE_URL` points at the bucket's own domain once one exists
 * (img.tomaappliances.com), which takes the Worker out of the request path
 * entirely. Until then `/img/...` serves from the binding, which works in
 * local development with no Cloudflare account at all.
 */
export function photoUrl(
  stem: string,
  size: PhotoSize = 'card',
  format: PhotoFormat = 'webp',
): string {
  // Optional-chained: outside Vite -- the test runner, say -- `import.meta.env`
  // does not exist at all, and a URL builder has no business throwing over it.
  const base = import.meta.env?.PUBLIC_IMAGE_BASE_URL?.replace(/\/$/, '') || '/img'
  return `${base}/${stem}-${size}.${format}`
}

export const photoObjectKeys = (stem: string, format: PhotoFormat = 'webp'): string[] =>
  (['thumb', 'card', 'full'] as PhotoSize[]).map((s) => `${stem}-${s}.${format}`)
