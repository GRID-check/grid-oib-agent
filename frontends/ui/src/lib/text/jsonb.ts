/**
 * Making arbitrary JSON safe for a Postgres `jsonb` column.
 *
 * `jsonb` rejects NUL bytes outright, and unpaired surrogates with them. Both
 * ride in inside extracted document text — a PDF or spreadsheet cell carrying
 * a stray NUL, or a buffer decoded with the wrong encoding, ends up in cards,
 * citations or provenance — and Drizzle then fails the whole write with
 * `Failed query … params: <the entire blob>`, which buries the real Postgres
 * cause under kilobytes of payload (err2issue #581/#579/#576: three PATCH
 * 500s whose reports were all blob, no cause).
 *
 * Stripping is lossless in every sense that matters here: NUL has no
 * rendering and no meaning in prose, and a lone surrogate half is already
 * damaged text — no JSON string needs either. Callers pass the value they
 * were about to write; what comes back is structurally identical minus the
 * codepoints the column cannot hold.
 *
 * Precondition: the value must be JSON-like (no cycles, no class instances).
 * Everything this feeds — `JSON.parse` output and the conversation sanitizers
 * — already satisfies that, and Drizzle would `JSON.stringify` it anyway.
 */

// NUL, a high surrogate with no low half after it, a low half with no high
// half before it. Written as escapes: no literal control character belongs in
// source, not even inside a regex.
// eslint-disable-next-line no-control-regex
const JSONB_UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Deep-strip what `jsonb` cannot store from strings, array items, and object
 * keys and values. Non-string leaves pass through untouched, so numbers,
 * booleans and nulls keep their types and the result stays a valid payload.
 */
export function stripJsonNullBytes<T>(value: T): T {
  if (typeof value === 'string') return value.replace(JSONB_UNSTORABLE, '') as T
  if (Array.isArray(value)) return value.map(stripJsonNullBytes) as T
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key.replace(JSONB_UNSTORABLE, '')] = stripJsonNullBytes(entry)
    }
    return out as T
  }
  return value
}
