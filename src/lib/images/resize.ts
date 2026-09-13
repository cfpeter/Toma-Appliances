/**
 * Shrink a camera photo in the browser, before anything is uploaded.
 *
 * A phone photo off a modern camera is ~4 MB and 4032 px wide. Uploading that
 * from a warehouse on bad wifi is the difference between the job taking two
 * minutes and taking twenty -- and nothing on the site ever displays an image
 * that large. The phone has a GPU sitting idle, so it does the work for free.
 *
 * Runs in the browser only: it needs canvas and createImageBitmap.
 */

export type PhotoSize = 'thumb' | 'card' | 'full'

/** Longest edge, in pixels. Anything already smaller is left alone. */
export const SIZES: Record<PhotoSize, { edge: number; quality: number }> = {
  thumb: { edge: 400, quality: 0.72 }, // grids
  card: { edge: 800, quality: 0.78 }, // listing cards
  full: { edge: 1600, quality: 0.82 }, // detail view
}

export interface RenderedPhoto {
  size: PhotoSize
  blob: Blob
  width: number
  height: number
}

/** Longest edge capped at `edge`, aspect ratio kept, never upscaled. */
export function fit(width: number, height: number, edge: number) {
  const longest = Math.max(width, height)
  if (longest <= edge) return { width, height }
  const scale = edge / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

async function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  // WebP is ~30% smaller than JPEG at the same perceived quality and has been
  // safe in every current browser for years.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', quality),
  )
  if (!blob) throw new Error('Could not encode the image.')
  return blob
}

/**
 * Decode a camera file into the three sizes the site serves.
 *
 * `imageOrientation: 'from-image'` matters more than it looks: a photo taken
 * in portrait carries its rotation in EXIF rather than in the pixels, and a
 * canvas that ignores that produces a sideways appliance.
 */
export async function renderSizes(file: File): Promise<RenderedPhoto[]> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name} is not an image.`)
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const out: RenderedPhoto[] = []
    for (const size of Object.keys(SIZES) as PhotoSize[]) {
      const { edge, quality } = SIZES[size]
      const { width, height } = fit(bitmap.width, bitmap.height, edge)

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is unavailable in this browser.')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, width, height)

      out.push({ size, blob: await toBlob(canvas, quality), width, height })
    }
    return out
  } finally {
    bitmap.close()
  }
}
