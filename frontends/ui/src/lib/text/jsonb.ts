/**
 * Making arbitrary JSON safe for a Postgres `jsonb` column.
 *
 * `jsonb` rejects exactly one codepoint: U+0000 (NUL). It rides in inside
 * extracted document text — a PDF or spreadsheet cell carrying a stray NUL
 * ends up in cards, citations or provenance — and Drizzle then fails the whole
 * write with `Failed query … params: <the entire blob>`, which buries the real
 * Postgres cause under kilobytes of payload (err2issue #581/#579/#576: three
 * PATCH 500s whose reports were all blob, no cause).
 *
 * Stripping NUL is lossless in every sense that matters here: NUL has no
 * rendering, no meaning in prose, and no JSON string needs it. Callers pass
 * the value they were about to write; what comes back is structurally
 * identical minus the one codepoint the column cannot hold.
 *
 * Precondition: the value must be JSON-like (no cycles, no class instances).
 * Everything this feeds — `JSON.parse` output and the conversation sanitizers
 * — already satisfies that, and Drizzle would `JSON.stringify` it anyway.
 */

// eslint-disable-next-line no-control-regex
const NUL = /\u0000/g

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Deep-strip U+0000 from strings, array items, and object keys and values.
 * Non-string leaves pass through untouched, so numbers, booleans and nulls
 * keep their types and the result stays a valid jsonb payload.
 */
export function stripJsonNullBytes<T>(value: T): T {
  if (typeof value === 'string') return value.replace(NUL, '') as T
  if (Array.isArray(value)) return value.map(stripJsonNullBytes) as T
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key.replace(NUL, '')] = stripJsonNullBytes(entry)
    }
    return out as T
  }
  return value
}
