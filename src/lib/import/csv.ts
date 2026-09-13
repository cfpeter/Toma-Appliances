/**
 * Minimal RFC-4180 CSV reader.
 *
 * Written by hand rather than pulled in as a dependency: B-Stock manifests are
 * small and well-formed, and everything here must run in the Cloudflare Workers
 * runtime, where many Node-oriented CSV libraries do not.
 */

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  // Strip a UTF-8 BOM — Excel adds one and it corrupts the first header name.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const header = rows.shift()
  if (!header) return []

  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const obj: Record<string, string> = {}
      header.forEach((h, i) => {
        obj[h.trim()] = (r[i] ?? '').trim()
      })
      return obj
    })
}
