/**
 * The answer's structured anatomy (`answer_meta`), made durable.
 *
 * A research answer is generated as one JSON envelope whose optional fields —
 * the headline verdict, the takeaways, the single callout — are the answer's
 * own RHETORICAL structure. The backend validates and GATES them
 * (`src/aiq_agent/common/answer_envelope.py`: a verdict is a copyable ≤60-char
 * VALUE, a takeaway block is earned by answer length, one callout at most) and
 * ships the survivors as the `answer_meta` wire field, versioned under `v`.
 * They are native answer fields — never cards, never in the `cards` array —
 * and the frontend renders them in a FIXED layout: verdict above the prose,
 * callout and takeaways after it.
 *
 * **The client is not trusted with the bound**, exactly as `sanitizeStages` is
 * not. This lands in `messages.metadata.answerMeta` — jsonb on a hot table fed
 * from a browser — so the key set is closed, lists are truncated and every
 * string is capped, on WRITE and again on READ (`server-message-mapper`), so a
 * row written by an older or malicious client still renders safely.
 *
 * The caps mirror the backend gates rather than inventing their own numbers:
 * this is the TypeScript half of one contract, pinned against the Python half
 * by the shared fixture `tests/fixtures/answer_meta/wire_payload.json` — a
 * crossing test on each side, so a renamed key cannot ship green.
 */

/** The contract version this build understands. */
export const ANSWER_META_VERSION = 1

/** Mirrors `VERDICT_VALUE_MAX_CHARS` — a verdict is a VALUE, not a sentence. */
export const VERDICT_VALUE_MAX_CHARS = 60
const MAX_SUBJECT_CHARS = 200
const MAX_TAKEAWAYS = 5
const MAX_TEXT_CHARS = 300
const MAX_DETAIL_CHARS = 600
const MAX_REFERENCE_CHARS = 120

export const CALLOUT_KINDS = ['hinweis', 'achtung', 'frist', 'tipp'] as const
export type AnswerCalloutKind = (typeof CALLOUT_KINDS)[number]

/** The Fundstelle a verdict rests on; the card `NormReference` shape. */
export interface AnswerMetaReference {
  document: string
  section?: string
  edition?: string
}

export interface AnswerMetaVerdict {
  value: string
  subject: string
  reference?: AnswerMetaReference
}

export interface AnswerMetaTakeaway {
  text: string
  detail?: string
}

export interface AnswerMetaCallout {
  kind: AnswerCalloutKind
  text: string
  title?: string
  detail?: string
}

/**
 * The stored/rendered anatomy. `v` names the contract version the writer
 * spoke; every other field is optional and absent when it did not survive the
 * backend's gates.
 */
export interface AnswerMeta {
  v: number
  verdict?: AnswerMetaVerdict
  takeaways?: AnswerMetaTakeaway[]
  callout?: AnswerMetaCallout
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined

function sanitizeReference(input: unknown): AnswerMetaReference | undefined {
  if (!isRecord(input)) return undefined
  const document = cap(input.document, MAX_REFERENCE_CHARS)
  if (!document) return undefined
  const reference: AnswerMetaReference = { document }
  const section = cap(input.section, MAX_REFERENCE_CHARS)
  if (section) reference.section = section
  const edition = cap(input.edition, MAX_REFERENCE_CHARS)
  if (edition) reference.edition = edition
  return reference
}

function sanitizeVerdict(input: unknown): AnswerMetaVerdict | undefined {
  if (!isRecord(input)) return undefined
  // The value cap is the backend's GATE, not just a bound: a longer value was
  // never a verdict, so it is dropped whole rather than truncated into one.
  const raw = typeof input.value === 'string' ? input.value.trim() : ''
  if (!raw || raw.length > VERDICT_VALUE_MAX_CHARS) return undefined
  const subject = cap(input.subject, MAX_SUBJECT_CHARS)
  if (!subject) return undefined
  const verdict: AnswerMetaVerdict = { value: raw, subject }
  const reference = sanitizeReference(input.reference)
  if (reference) verdict.reference = reference
  return verdict
}

function sanitizeTakeaways(input: unknown): AnswerMetaTakeaway[] | undefined {
  if (!Array.isArray(input)) return undefined
  const items: AnswerMetaTakeaway[] = []
  for (const raw of input) {
    if (items.length >= MAX_TAKEAWAYS) break
    if (!isRecord(raw)) continue
    const text = cap(raw.text, MAX_TEXT_CHARS)
    if (!text) continue
    const detail = cap(raw.detail, MAX_DETAIL_CHARS)
    items.push(detail ? { text, detail } : { text })
  }
  // Two is the backend's floor too: one takeaway is a sentence, not a block.
  return items.length >= 2 ? items : undefined
}

function sanitizeCallout(input: unknown): AnswerMetaCallout | undefined {
  if (!isRecord(input)) return undefined
  const kind = typeof input.kind === 'string' ? input.kind : ''
  if (!(CALLOUT_KINDS as readonly string[]).includes(kind)) return undefined
  const text = cap(input.text, MAX_TEXT_CHARS)
  if (!text) return undefined
  const callout: AnswerMetaCallout = { kind: kind as AnswerCalloutKind, text }
  const title = cap(input.title, MAX_TEXT_CHARS)
  if (title) callout.title = title
  const detail = cap(input.detail, MAX_DETAIL_CHARS)
  if (detail) callout.detail = detail
  return callout
}

/**
 * Reduce an untrusted `answer_meta` payload to a bounded one, or null when
 * nothing survives.
 *
 * A payload from a FUTURE contract version is kept (its known fields
 * sanitized, its unknown fields dropped) rather than refused: additive
 * evolution is the contract, and a rollback must not blank what a newer writer
 * stored. `v` is normalised to a number, defaulting to version 1 for a legacy
 * payload that predates the stamp.
 */
export function sanitizeAnswerMeta(input: unknown): AnswerMeta | null {
  if (!isRecord(input)) return null

  const verdict = sanitizeVerdict(input.verdict)
  const takeaways = sanitizeTakeaways(input.takeaways)
  const callout = sanitizeCallout(input.callout)
  if (!verdict && !takeaways && !callout) return null

  const version = typeof input.v === 'number' && Number.isFinite(input.v) ? input.v : ANSWER_META_VERSION
  const meta: AnswerMeta = { v: version }
  if (verdict) meta.verdict = verdict
  if (takeaways) meta.takeaways = takeaways
  if (callout) meta.callout = callout
  return meta
}
