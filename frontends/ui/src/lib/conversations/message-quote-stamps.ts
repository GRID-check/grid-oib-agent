/**
 * The server's check of every quote line `> „…" [N]` in an answer
 * (`TurnResult.quote_stamps`, `src/aiq_agent/common/quote_stamps.py`), made
 * durable.
 *
 * One stamp per quote line, in document order: `verbatim` names the retrieved
 * passage that holds the wording (title, file, page, Punkt) and the `[N]` it
 * carries; `not_found` means no passage this turn retrieved holds it;
 * `unchecked` means there was nothing to check against. The excerpt renderer
 * draws „Wortlaut belegt [N]" from it, never from the model's word.
 *
 * Like the retrieval ledger it lands in message provenance (jsonb, written by
 * the browser and by the agent tier), so the key set is closed and every string
 * is capped on write and again on read. Wire names are snake_case; the stored
 * and client shape is camelCase.
 */

export type QuoteStampStatus = 'verbatim' | 'not_found' | 'unchecked'

export interface QuoteStamp {
  /** The wording between the quote marks, as the final text writes it. */
  text: string
  status: QuoteStampStatus
  /** The `[N]` the quote carries, when the passage was cited. */
  number?: number
  title?: string
  fileName?: string
  page?: number
  punkt?: string
  url?: string
}

const STATUSES: ReadonlySet<string> = new Set(['verbatim', 'not_found', 'unchecked'])
/** A turn quotes a handful of passages; a hundred is a runaway producer. */
const MAX_STAMPS = 40
/** A quote line is a sentence or two. */
const MAX_TEXT_CHARS = 1200
const MAX_TITLE_CHARS = 256
const MAX_NAME_CHARS = 256
const MAX_PUNKT_CHARS = 64
const MAX_URL_CHARS = 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined

/** One stamp in either spelling (wire `file_name`, stored `fileName`), or undefined. */
function sanitizeStamp(input: unknown): QuoteStamp | undefined {
  if (!isRecord(input)) return undefined
  const text = cap(input.text, MAX_TEXT_CHARS)
  const status = typeof input.status === 'string' && STATUSES.has(input.status) ? (input.status as QuoteStampStatus) : undefined
  if (!text || !status) return undefined
  const stamp: QuoteStamp = { text, status }
  const number = positive(input.number)
  if (number !== undefined) stamp.number = number
  const title = cap(input.title, MAX_TITLE_CHARS)
  if (title) stamp.title = title
  const fileName = cap(input.fileName ?? input.file_name, MAX_NAME_CHARS)
  if (fileName) stamp.fileName = fileName
  const page = positive(input.page)
  if (page !== undefined) stamp.page = page
  const punkt = cap(input.punkt, MAX_PUNKT_CHARS)
  if (punkt) stamp.punkt = punkt
  const url = cap(input.url, MAX_URL_CHARS)
  if (url && /^https?:\/\//i.test(url)) stamp.url = url
  return stamp
}

/** The stamps, bounded, or null when none survive. */
export function sanitizeQuoteStamps(input: unknown): QuoteStamp[] | null {
  if (!Array.isArray(input)) return null
  const stamps: QuoteStamp[] = []
  for (const raw of input) {
    if (stamps.length >= MAX_STAMPS) break
    const stamp = sanitizeStamp(raw)
    if (stamp) stamps.push(stamp)
  }
  return stamps.length > 0 ? stamps : null
}

/** Quote text compared the way the server's coverage test reads it: marks, case and spacing aside. */
export const normalizeQuote = (text: string): string =>
  text
    .replace(/==/g, '')
    .replace(/[„“”"‚‘’'«»]/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .toLocaleLowerCase('de')

/**
 * The stamp for one quote line: the first whose wording the line holds (or
 * that holds the line's, for a line the renderer split), preferring one that
 * carries the same `[N]`.
 */
export function stampForQuote(stamps: readonly QuoteStamp[] | undefined, quote: string, number?: number): QuoteStamp | null {
  if (!stamps || stamps.length === 0) return null
  const wanted = normalizeQuote(quote)
  if (!wanted) return null
  const matches = stamps.filter((stamp) => {
    const have = normalizeQuote(stamp.text)
    return have.length > 0 && (wanted.includes(have) || have.includes(wanted))
  })
  return matches.find((stamp) => number !== undefined && stamp.number === number) ?? matches[0] ?? null
}
