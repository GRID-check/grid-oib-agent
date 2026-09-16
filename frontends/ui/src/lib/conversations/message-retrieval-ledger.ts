/**
 * The backend's own account of a turn's retrieval rounds (`retrieval_ledger`),
 * made durable.
 *
 * One entry per announced round: what the round was asked (query, tools),
 * what it returned (one entry per PASSAGE, with title/detail/shelf and the
 * backend's `repeat` verdict), and which documents it did WORK on (`newDocs`:
 * the ones with at least one passage that was not a repeat). The
 * Herleitung spine draws each round's fan from it
 * (`features/chat/lib/retrieval-rounds.ts` — `roundFan`, one card per
 * document), and it is stored so a reload draws the same one: the backend
 * states what the turn did, once, and every surface reads that same record.
 *
 * **The client is not trusted with the bound**, exactly as `sanitizeAnswerMeta`
 * is not. This lands in message metadata/provenance — jsonb fed from a
 * browser — so the key set is closed, lists are truncated and every string is
 * capped, on WRITE and again on READ (`server-message-mapper`), so a row
 * written by an older or malicious client still renders safely.
 *
 * The caps mirror the backend budgets where they exist (query/reason travel
 * clipped by `turn_status`, and are truncated — not dropped — here for the
 * same reason), and are generous client bounds everywhere else. Wire names
 * are snake_case; everything downstream of this file is camelCase.
 *
 * Pinned against the Python half by the shared fixture
 * `tests/fixtures/herleitung/retrieval_ledger_wire.json` — a crossing test on
 * each side, so a renamed key cannot ship green.
 */

/**
 * One PASSAGE a round returned: a document plus the page or Punkt it was
 * reached at. `name` is filename or URL — never empty.
 */
export interface RetrievalLedgerDoc {
  name: string
  title?: string
  detail?: string
  shelf?: string
  /**
   * The round fetched this passage a second time — the backend's own verdict,
   * which is the only side that can reach it (it needs every earlier round).
   * Absent on a turn stored before the backend stamped it; the renderer then
   * falls back to the document-level `newDocs`.
   */
  repeat?: boolean
}

/** One announced retrieval round. `newDocs` is a subset of `docs`. */
export interface RetrievalLedgerEntry {
  index: number
  key: string
  tools: string[]
  corpora: string[]
  query?: string
  /** The round's own words, verbatim — narration, never a verdict. */
  reason?: string
  docs: RetrievalLedgerDoc[]
  /**
   * The documents with at least one passage in `docs` that was not a repeat.
   * A file an earlier round opened is still listed here when this round
   * reached a passage of it that nobody had fetched.
   */
  newDocs: string[]
  /** Document entries in `docs` (the same file at two pages counts twice). */
  hits: number
  /** Distinct documents in `docs` (the same file at two pages counts once). */
  documents: number
}

export type RetrievalLedger = RetrievalLedgerEntry[]

/** Backend loop budget is 7 + reserve; headroom, not a target. */
const MAX_ROUNDS = 12
/** Mirrors `turn_status.MAX_QUERY_CHARS` — the frame clips, this truncates. */
const MAX_QUERY_CHARS = 32
/** Mirrors `turn_status.MAX_REASON_CHARS` — same rule. */
const MAX_REASON_CHARS = 160
const MAX_KEY_CHARS = 64
const MAX_TOOL_CHARS = 64
const MAX_CORPUS_CHARS = 32
const MAX_DOCS_PER_ROUND = 100
const MAX_NEW_DOCS = 100
const MAX_TOOLS = 32
const MAX_CORPORA = 8
const MAX_NAME_CHARS = 256
const MAX_TITLE_CHARS = 256
const MAX_DETAIL_CHARS = 128
const MAX_SHELF_CHARS = 64

/** A plain JSON object — never an array, never null. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A trimmed non-empty string within budget, or undefined. */
const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined

/** A bounded string list: capped items, dropped empties, undefined when none survive. */
const capList = (value: unknown, maxItems: number, maxChars: number): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const raw of value) {
    if (items.length >= maxItems) break
    const text = cap(raw, maxChars)
    if (text !== undefined) items.push(text)
  }
  return items.length > 0 ? items : undefined
}

/** A safe non-negative integer, or undefined. */
const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined

/** Presentation compare matching the backend's own: case- and space-insensitive. */
const docKey = (name: string): string => name.trim().toLowerCase()

/** One bounded ledger doc, or undefined when it has no name. */
function sanitizeDoc(input: unknown): RetrievalLedgerDoc | undefined {
  if (!isRecord(input)) return undefined
  const name = cap(input.name, MAX_NAME_CHARS)
  if (!name) return undefined
  const doc: RetrievalLedgerDoc = { name }
  const title = cap(input.title, MAX_TITLE_CHARS)
  if (title !== undefined) doc.title = title
  const detail = cap(input.detail, MAX_DETAIL_CHARS)
  if (detail !== undefined) doc.detail = detail
  const shelf = cap(input.shelf, MAX_SHELF_CHARS)
  if (shelf !== undefined) doc.shelf = shelf
  // Copied, not derived: "was this passage fetched before" is a fact about
  // every EARLIER round, which this payload does not carry. A boolean is
  // self-bounding, and the worst a tampered one can do is mute or unmute one
  // pill — unlike a tally, which could render "999 Treffer" over one file.
  if (typeof input.repeat === 'boolean') doc.repeat = input.repeat
  return doc
}

/** One bounded ledger entry, or undefined when it has no index. Tallies are derived from docs. */
function sanitizeEntry(input: unknown): RetrievalLedgerEntry | undefined {
  if (!isRecord(input)) return undefined
  const index = int(input.index)
  // Without an index the entry is unorderable — corrupt, not roundable.
  // Other entries survive: one bad entry must not blank the turn's account.
  if (index === undefined) return undefined
  const docs: RetrievalLedgerDoc[] = []
  if (Array.isArray(input.docs)) {
    for (const raw of input.docs) {
      if (docs.length >= MAX_DOCS_PER_ROUND) break
      const doc = sanitizeDoc(raw)
      if (doc) docs.push(doc)
    }
  }
  const names = new Set(docs.map((doc) => docKey(doc.name)))
  // The tallies and `newDocs` are DERIVED from the bounded docs, never copied:
  // this is the untrusted boundary, and a tampered payload rendering
  // "999 Treffer" over an empty list is exactly what this file exists to stop.
  const entry: RetrievalLedgerEntry = {
    index,
    key: cap(input.key, MAX_KEY_CHARS) ?? '',
    tools: capList(input.tools, MAX_TOOLS, MAX_TOOL_CHARS) ?? [],
    corpora: capList(input.corpora, MAX_CORPORA, MAX_CORPUS_CHARS) ?? [],
    docs,
    newDocs:
      capList(input.new_docs, MAX_NEW_DOCS, MAX_NAME_CHARS)?.filter((name) => names.has(docKey(name))) ?? [],
    hits: docs.length,
    documents: names.size,
  }
  const query = cap(input.query, MAX_QUERY_CHARS)
  if (query !== undefined) entry.query = query
  const reason = cap(input.reason, MAX_REASON_CHARS)
  if (reason !== undefined) entry.reason = reason
  return entry
}

/**
 * Reduce an untrusted `retrieval_ledger` payload to a bounded one, or null
 * when nothing survives.
 *
 * A round with zero docs is KEPT: an announced search that found nothing is
 * exactly when the reader most needs the layer. An entry without an index is
 * corrupt and skipped; the rest of the turn's account survives it.
 */
export function sanitizeRetrievalLedger(input: unknown): RetrievalLedger | null {
  if (!Array.isArray(input)) return null
  const entries: RetrievalLedger = []
  for (const raw of input) {
    if (entries.length >= MAX_ROUNDS) break
    const entry = sanitizeEntry(raw)
    if (entry) entries.push(entry)
  }
  return entries.length > 0 ? entries : null
}
