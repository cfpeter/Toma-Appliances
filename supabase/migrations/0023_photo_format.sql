-- ═══════════════════════════════════════════════════════════════════════════
-- Photos remember which format they were actually encoded in
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The uploader asked the canvas for WebP and assumed it got WebP. Safari does
-- not encode WebP: `canvas.toBlob(cb, 'image/webp')` silently returns a PNG
-- instead, and the client then labelled that PNG image/webp on its way out.
-- A 1600px PNG photograph is several megabytes, so every upload from an
-- iPhone was rejected by the size limit -- with a message blaming the resize,
-- which had in fact worked.
--
-- The format now depends on what the browser could actually produce, so the
-- object key can no longer assume an extension.

alter table product_photos
  add column if not exists format text not null default 'webp'
  check (format in ('webp', 'jpeg'));

comment on column product_photos.format is
  'Encoding the browser actually managed. Decides the object extension.';

-- Existing rows predate the fallback and really are WebP; the default covers
-- them. anon needs it to build an image URL.
grant select (format) on product_photos to anon;
