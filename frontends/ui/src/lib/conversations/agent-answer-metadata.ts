/**
 * The backend's answer metadata, translated into the contract the client reads.
 *
 * Two writers produce an assistant message row and they do NOT speak the same
 * dialect:
 *
 *   * the **browser**, which writes the canonical stored shape — `citations`
 *     (the versioned envelope `lib/citations/persistence` decodes) and
 *     `provenance` (camelCase, bounded by {@link sanitizeProvenance});
 *   * the **Python backend**, over the internal service-token route, when the
 *     client dropped mid-turn (`websocket_reconnect.persist_assistant_message`)
 *     or when the jobs runner materialises a finished run. That writer posts the
 *     wire spelling it already holds: `sources`, `answer_confidence`,
 *     `answer_confidence_reason`, `answer_confidence_capped_reason`,
 *     `deep_research_job_id`, and the marks the run left on its own answer
 *     (`research_truncated`, `truncation_reason`, `degraded_reasons`,
 *     `citations_removed`).
 *
 * Both shapes landed in the same jsonb column, and the reader
 * (`features/chat/lib/server-message-mapper`) only ever looked for the first
 * one. So the turns that MOST need the server row — the ones whose client was
 * already gone, which is exactly when history is the only copy — rehydrated as
 * a bare answer: no sources row, no confidence, no locator to click. The
 * information reached the BFF intact and died at the storage boundary.
 *
 * This module is that boundary, made explicit: one mapping table, applied on the
 * internal path only (the browser already writes canonical), so a message
 * persisted by the backend reads back identically to one persisted by the tab
 * that asked the question.
 *
 * ## Why translate on write rather than tolerate both shapes on read
 *
 * A reader that branches on shape has to keep branching forever, and every
 * surface that later reads a message row (the shared-thread load path, an
 * export, the profiler) would have to learn both dialects. Normalising once,
 * where the foreign dialect enters, means the database holds ONE contract.
 *
 * ## Why the write must guarantee decodability
 *
 * `decodeCitations` parses the envelope with a strict schema: a single source
 * whose `page` is `0` or whose `title` is a number fails the whole payload, and
 * the answer comes back with its entire provenance row missing rather than with
 * one imperfect chip. The writer is the only place that can prevent that, so
 * this module validates PER ENTRY against the reader's own constraints and drops
 * what would not survive — a partial source list is honest, a silently empty one
 * is not.
 *
 * Nothing here classifies or upgrades a source. `source_type` is carried
 * verbatim because it is the backend's coarse fact; deciding from it whether a
 * norm BINDS the reader is a legal judgement no frontend may make.
 */

import { CITATIONS_PAYLOAD_VERSION } from '@/features/chat/lib/citations'
import type { WireCitationSource } from '@/features/chat/types'
import { sanitizeProvenance, type MessageProvenance } from './message-provenance'
import { sanitizeAnswerMeta } from './message-answer-meta'

/**
 * The metadata keys the backend writes in wire spelling. Listed so the
 * translation is reversible by eye and so the snake_case originals can be
 * removed from the row — leaving them would seed a second dialect in the column
 * that a future reader might start honouring.
 */
const BACKEND_ANSWER_KEYS = [
  'sources',
  'answer_confidence',
  'answer_confidence_reason',
  'answer_confidence_capped_reason',
  'deep_research_job_id',
  // The marks a run leaves on its own answer. These arrive on the row written
  // by the JOBS runner (`jobs/conversation_output.write_job_turn`), which is
  // the only writer a deep-research turn ever has: nobody holds a socket for a
  // job that finishes tomorrow. Left undecoded, a salvaged, partially
  // researched report reopened from history rendered identically to a complete
  // one — the answer said nothing, because the only copy of the fact was a key
  // no reader looked at.
  'research_truncated',
  'truncation_reason',
  'degraded_reasons',
  'citations_removed',
  // The answer's structured anatomy (verdict / takeaways / callout) — the
  // envelope's gated wire payload, stored under the camelCase key the client
  // writer uses so history reads one dialect.
  'answer_meta',
] as const

/**
 * Sources kept per message. A turn cites tens of passages; a four-figure array
 * is a runaway producer, and this lands in jsonb.
 */
const MAX_SOURCES = 200

/**
 * Longest `content` kept per source, matching the browser writer's own cap:
 * a chip needs the locator, not the passage.
 */
const MAX_CONTENT = 400

/** Caps on the free-text locator fields, so no single field can dominate the row. */
const MAX_TEXT = 500
/** `document_id` / `citation_key` are identifiers, not prose. */
const MAX_IDENTIFIER = 256

/**
 * Longest retrieved PASSAGE kept per source.
 *
 * Sized to the serializer's own bound rather than to `MAX_CONTENT`: the two are
 * different things, and clipping this one hard is not a saving, it is a silent
 * downgrade. The passage matchers anchor on BOTH ends of a snippet, so a
 * truncated tail turns "the sentence is marked" into "the page is open" with
 * nothing on screen saying why.
 */
const MAX_SNIPPET = 1200

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined

/**
 * A positive integer, or undefined. `page` and `number` are both constrained
 * that way by the reader's schema, and both arrive from a producer that may
 * legitimately not know them.
 */
const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

/**
 * One stored source, in the wire spelling the reader decodes.
 *
 * Deliberately the same field names the backend sends and the same ones
 * `citationFromWire` reads, so there is no third naming convention in the
 * system. Every field is optional because a source is a locus in one of several
 * lanes: a web hit has a `url` and no `page`, a KB passage has `file_name` +
 * `page` and no `url`, and neither is malformed.
 */
export type StoredCitationSource = Partial<
  Pick<
    WireCitationSource,
    | 'content'
    | 'url'
    | 'title'
    | 'citation_key'
    | 'document_id'
    | 'collection'
    | 'source_type'
    | 'tool'
    | 'origin'
    | 'number'
    | 'file_name'
    | 'page'
    | 'kind'
    | 'shelf'
    | 'lane'
    | 'lane_label'
    | 'binding_note'
    | 'binding_status'
    | 'punkt'
    | 'score'
    | 'snippet'
  >
> & {
  /** Whether the answer cited this source, as opposed to merely retrieving it. */
  is_cited?: boolean
}

/** The versioned envelope the message row stores under `citations`. */
export interface StoredCitations {
  v: typeof CITATIONS_PAYLOAD_VERSION
  sources: StoredCitationSource[]
}

/**
 * Narrow one backend wire source to the stored shape.
 *
 * Returns null when nothing identifying survives. A source with no locator, no
 * URL and no text is not a weaker citation — it is not a citation at all, and
 * storing it would put an unopenable, unlabelled chip under an answer about
 * building law.
 */
function normalizeSource(input: unknown): StoredCitationSource | null {
  if (!isRecord(input)) return null

  const source: StoredCitationSource = {
    content: text(input.content, MAX_CONTENT),
    url: text(input.url, MAX_TEXT),
    title: text(input.title, MAX_TEXT),
    citation_key: text(input.citation_key, MAX_IDENTIFIER),
    // The click-through triple (FB-4): which document, which file, which page.
    // Carried as the backend states it — the frontend must never guess a
    // filename from display text to open a preview.
    document_id: text(input.document_id, MAX_IDENTIFIER),
    file_name: text(input.file_name, MAX_TEXT),
    page: positiveInt(input.page),
    collection: text(input.collection, MAX_IDENTIFIER),
    // The authority signals, verbatim from the backend (FB-2): the coarse
    // `source_type`, the `[KB]`/`[RIS]`/`[Web]` origin, the shelf, the retrieval
    // lane and the norm registry's binding note. No value here is derived from
    // another — a "binding" claim is the registry's to make or nobody's.
    source_type: text(input.source_type, MAX_IDENTIFIER),
    origin: text(input.origin, MAX_IDENTIFIER),
    shelf: text(input.shelf, MAX_IDENTIFIER),
    kind: text(input.kind, MAX_IDENTIFIER),
    lane: text(input.lane, MAX_IDENTIFIER),
    lane_label: text(input.lane_label, MAX_TEXT),
    binding_note: text(input.binding_note, MAX_TEXT),
    binding_status: text(input.binding_status, MAX_IDENTIFIER),
    tool: text(input.tool, MAX_IDENTIFIER),
    // WHERE in the document, and the words themselves.
    //
    // This normalizer enumerates the wire, so a field it does not list is
    // dropped — and it is applied to every row the PYTHON side persists:
    // an answer whose client was gone mid-turn, and every deep-research answer,
    // since nobody holds a socket for a job that finishes tomorrow. So the
    // passage reached a live tab and was lost on exactly the turns a reader
    // comes back to, and the loss was invisible because a citation with no
    // passage opens the page and marks nothing, which is a supported outcome.
    punkt: text(input.punkt, MAX_IDENTIFIER),
    score:
      typeof input.score === 'number' && Number.isFinite(input.score) ? input.score : undefined,
    snippet: text(input.snippet, MAX_SNIPPET),
    // The `[N]` label this source carries in the answer prose. The one fact the
    // frontend cannot recover on its own: the number→source binding exists only
    // in the backend's citation verification.
    number: positiveInt(input.number),
    ...(typeof input.is_cited === 'boolean' ? { is_cited: input.is_cited } : {}),
  }

  const identifying =
    source.url ??
    source.file_name ??
    source.document_id ??
    source.citation_key ??
    source.title ??
    source.content
  if (!identifying) return null

  // Drop the keys that came out undefined rather than storing explicit nulls:
  // the reader treats absent and null alike, and a row full of nulls makes it
  // impossible to tell "the backend did not know" from "we dropped it".
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined)
  ) as StoredCitationSource
}

/**
 * Encode the backend's `sources` array as the stored citations envelope.
 *
 * Returns undefined when nothing usable survives, so a message with no
 * provenance stores no key at all rather than an empty array — a surface cannot
 * tell "we checked and there were none" from "we lost them" once that is
 * written.
 */
export function encodeBackendSources(input: unknown): StoredCitations | undefined {
  if (!Array.isArray(input)) return undefined
  const sources = input
    .slice(0, MAX_SOURCES)
    .map(normalizeSource)
    .filter((source): source is StoredCitationSource => source !== null)
  return sources.length > 0 ? { v: CITATIONS_PAYLOAD_VERSION, sources } : undefined
}

/**
 * Read the answer's self-assessment — and the marks its run left on it — off the
 * backend's metadata.
 *
 * The level and its reason travel TOGETHER on purpose. The backend's marker is
 * `[CONFIDENCE:level | reason]` (`shallow_researcher/markers.py`) and the reason
 * is the half that makes the level actionable: "niedrig" alone tells a reader
 * their answer might be wrong and nothing about what to check. A level whose
 * reason was dropped somewhere in transport is the exact complaint the backlog
 * records, so both halves are mapped in one place and neither can be added
 * without the other being considered.
 *
 * The transparency marks below travel the same way and for the same reason: a
 * cutoff, its cause and the degradations it caused are one statement, and half
 * of it is worse than none — "the search stopped early" with no cause reads as
 * an apology, and a degradation with no cutoff reads as an ordinary bad answer.
 *
 * Bounded by {@link sanitizeProvenance}, which owns the caps AND the token
 * allow-lists for this column: a reason token this build has no sentence for is
 * dropped there, so it can never reach a renderer as a raw identifier.
 */
export function provenanceFromBackendMetadata(
  metadata: Record<string, unknown>
): MessageProvenance | null {
  const candidate: Record<string, unknown> = {}

  if (typeof metadata.answer_confidence === 'string') {
    candidate.answerConfidence = metadata.answer_confidence
  }
  if (typeof metadata.answer_confidence_reason === 'string') {
    candidate.answerConfidenceReason = metadata.answer_confidence_reason
  }
  if (typeof metadata.answer_confidence_capped_reason === 'string') {
    candidate.answerConfidenceCappedReason = metadata.answer_confidence_capped_reason
  }
  // The pointer to the deep-research report, so a rehydrated turn can offer to
  // open it instead of the reader being handed an answer with no way back to
  // what produced it.
  if (typeof metadata.deep_research_job_id === 'string') {
    candidate.deepResearchJobId = metadata.deep_research_job_id
  }

  // ── What the run cost the answer ────────────────────────────────────────
  // Presence IS the fact: `=== true`, so a `false` on the wire is read as
  // "nothing recorded a cutoff" rather than as a second way of saying it. The
  // reason and the degradations are read INDEPENDENTLY of the flag, matching
  // the backend's own extractor — a state that lost the boolean but kept why it
  // stopped still knows something true, and dropping it here would make the
  // reopened thread quieter than the run actually was.
  if (metadata.research_truncated === true) candidate.researchTruncated = true
  if (typeof metadata.truncation_reason === 'string') {
    candidate.truncationReason = metadata.truncation_reason
  }
  if (Array.isArray(metadata.degraded_reasons)) {
    candidate.degradedReasons = metadata.degraded_reasons
  }
  // The citation-verification summary (`{count, reasons[]}`). It rode the live
  // socket to shallow answers from the start and never reached a deep one,
  // because a deep answer has no live socket to ride.
  if (isRecord(metadata.citations_removed)) {
    candidate.citationsRemoved = metadata.citations_removed
  }

  // The enums are re-checked there, not here: `sanitizeProvenance` is the single
  // gate on this column and a second copy of the value lists would drift.
  return sanitizeProvenance(candidate)
}

/**
 * Translate one backend-written metadata object into the stored contract.
 *
 * Idempotent and additive: a payload that already carries canonical `citations`
 * or `provenance` keeps them (the browser is the better-informed writer — it
 * saw the whole turn, including the Herleitung this path never has), and the
 * wire-spelled keys are removed either way so the column holds one dialect.
 */
export function normalizeAgentAnswerMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return metadata

  const hasBackendKeys = BACKEND_ANSWER_KEYS.some((key) => metadata[key] !== undefined)
  if (!hasBackendKeys) return metadata

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if ((BACKEND_ANSWER_KEYS as readonly string[]).includes(key)) continue
    out[key] = value
  }

  if (out.citations === undefined) {
    const citations = encodeBackendSources(metadata.sources)
    if (citations) out.citations = citations
  }

  if (out.provenance === undefined) {
    const provenance = provenanceFromBackendMetadata(metadata)
    if (provenance) out.provenance = provenance
  }

  if (out.answerMeta === undefined) {
    const answerMeta = sanitizeAnswerMeta(metadata.answer_meta)
    if (answerMeta) out.answerMeta = answerMeta
  }

  return out
}
