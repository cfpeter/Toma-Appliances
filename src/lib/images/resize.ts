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
  /** What the browser actually produced, not what was requested. */
  type: string
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

/** Files phones produce that browsers generally cannot decode. */
function unsupportedFormat(file: File): string | null {
  const name = file.name.toLowerCase()
  if (file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/.test(name)) {
    return (
      'iPhone sent this as HEIC, which browsers cannot read. ' +
      'On the phone: Settings → Camera → Formats → Most Compatible, then take the photo again.'
    )
  }
  return null
}

/**
 * Decode the file, scaling it down *during* decode when it is large.
 *
 * This is the part that decides whether a phone photo uploads at all. A 48 MP
 * camera roll image is 8064x6048, which is ~195 MB once decoded to pixels --
 * enough for iOS to kill the tab before any resizing happens. Passing a resize
 * hint lets the browser scale as it decodes, so the full-size bitmap never
 * exists. Aspect ratio is preserved as long as only one dimension is given.
 */
/**
 * Pixel dimensions, read straight out of the file header.
 *
 * Needed before decoding, to know whether decoding is safe -- and file size
 * cannot answer it: a flat, evenly-lit photo of a white appliance can be 48
 * megapixels and still compress under a megabyte. Only the header knows.
 *
 * Reads the first 64 KB, which comfortably covers the marker in any camera
 * JPEG. Returns null for anything it does not recognise, and the caller falls
 * back to a plain decode.
 */
export async function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  const buf = new DataView(await file.slice(0, 65_536).arrayBuffer())
  const len = buf.byteLength
  if (len < 24) return null

  // PNG: an IHDR chunk at a fixed offset.
  if (buf.getUint32(0) === 0x89504e47) {
    return { width: buf.getUint32(16), height: buf.getUint32(20) }
  }

  // WebP: RIFF container, dimensions depend on which of three codings it uses.
  if (buf.getUint32(0) === 0x52494646 && buf.getUint32(8) === 0x57454250) {
    const fourcc = buf.getUint32(12)
    if (fourcc === 0x56503858 && len >= 30) {
      // VP8X, 24-bit little-endian, stored as (value - 1)
      const w = (buf.getUint8(24) | (buf.getUint8(25) << 8) | (buf.getUint8(26) << 16)) + 1
      const h = (buf.getUint8(27) | (buf.getUint8(28) << 8) | (buf.getUint8(29) << 16)) + 1
      return { width: w, height: h }
    }
    if (fourcc === 0x56503820 && len >= 30) {
      // Lossy: 14 bits each, after the 3-byte start code
      return {
        width: buf.getUint16(26, true) & 0x3fff,
        height: buf.getUint16(28, true) & 0x3fff,
      }
    }
  }

  // JPEG: walk the segment chain to a Start Of Frame marker.
  if (buf.getUint16(0) === 0xffd8) {
    let i = 2
    while (i + 9 < len) {
      if (buf.getUint8(i) !== 0xff) {
        i++ // resynchronise rather than give up; padding bytes are legal
        continue
      }
      const marker = buf.getUint8(i + 1)
      // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc), carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.getUint16(i + 5), width: buf.getUint16(i + 7) }
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2
        continue
      }
      i += 2 + buf.getUint16(i + 2)
    }
  }

  return null
}

/**
 * Decode the file, scaling it down *during* decode when it is large.
 *
 * This is the step that decides whether a phone photo uploads at all. A 48 MP
 * camera image is 8064x6048 -- about 186 MB once decoded to pixels, enough for
 * a phone to kill the tab before any resizing happens. Giving the decoder a
 * target size lets it scale as it reads, so the full-size bitmap never exists.
 * Supplying only one dimension keeps the aspect ratio.
 */
async function decode(file: File): Promise<ImageBitmap> {
  const base: ImageBitmapOptions = { imageOrientation: 'from-image' }
  const edge = SIZES.full.edge
  const size = await readImageSize(file).catch(() => null)

  // Only when the source is genuinely bigger: the hint would otherwise
  // enlarge a small image to `edge`, which adds bytes and no detail.
  if (size && Math.max(size.width, size.height) > edge) {
    try {
      return await createImageBitmap(file, {
        ...base,
        resizeQuality: 'high',
        ...(size.width >= size.height ? { resizeWidth: edge } : { resizeHeight: edge }),
      })
    } catch {
      /* older browsers reject the resize hints; fall through */
    }
  }

  return createImageBitmap(file, base)
}

/** In preference order. WebP is ~30% smaller; JPEG works everywhere. */
const ENCODINGS = ['image/webp', 'image/jpeg'] as const
export type PhotoFormat = 'webp' | 'jpeg'

/**
 * Encode the canvas, and check what came back.
 *
 * `toBlob` does not fail when it cannot produce the type you asked for -- it
 * quietly encodes something else. Safari has no WebP encoder, so asking it
 * for WebP yields a PNG, and a 1600px PNG photograph is several megabytes.
 * That is what broke uploads from iPhones: the resize worked perfectly and
 * the result was rejected for being too big.
 *
 * So the returned blob's own type is the only thing worth believing.
 */
async function encode(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<{ blob: Blob; type: string }> {
  for (const type of ENCODINGS) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, quality),
    )
    if (blob && blob.type === type) return { blob, type }
  }
  throw new Error('This browser could not encode the resized photo.')
}

/**
 * Turn a camera file into the three sizes the site serves.
 *
 * `imageOrientation: 'from-image'` matters more than it looks: a photo taken
 * in portrait carries its rotation in EXIF rather than in the pixels, and a
 * canvas that ignores that produces a sideways appliance.
 */
export async function renderSizes(file: File): Promise<RenderedPhoto[]> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name} is not an image.`)
  }

  const bad = unsupportedFormat(file)
  if (bad) throw new Error(bad)

  let bitmap: ImageBitmap
  try {
    bitmap = await decode(file)
  } catch (e) {
    throw new Error(
      `Could not read ${file.name} (${(file.size / 1_048_576).toFixed(1)} MB). ` +
        `The phone may have run out of memory. ${e instanceof Error ? e.message : ''}`.trim(),
    )
  }
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

      const { blob, type } = await encode(canvas, quality)
      out.push({ size, blob, type, width, height })
    }
    return out
  } finally {
    bitmap.close()
  }
}
