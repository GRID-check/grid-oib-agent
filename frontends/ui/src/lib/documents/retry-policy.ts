/**
 * Whether reading a failed document again is worth anything — the one rule
 * every retry asks.
 *
 * Every manual „Erneut lesen“, every „Alle erneut lesen“ and every org rescan
 * used to send a failed file back through ingestion, forever, including the
 * file certain to fail the same way: an empty or encrypted PDF fails
 * identically on every attempt, and each attempt spends a download, a parse and
 * sometimes vision calls. The backend now says WHY a file failed
 * (`aiq_agent/knowledge/ingest_failures.py`): a category, a `retryable` flag
 * and the reader version that read it, which the reconcile persists on the row
 * (migration 0133). This module turns those into one answer.
 *
 * | category        | may read again                                           |
 * |-----------------|----------------------------------------------------------|
 * | `transient`     | yes (interrupted, timed out, a download or upstream call)|
 * | `configuration` | yes (the deployment lacked a vision model; once it has   |
 * |                 | one the same bytes read, and the BFF cannot tell when)   |
 * | `deterministic` | only when the bytes changed since the attempt that       |
 * |                 | failed, or the reader is newer than the one that failed  |
 * | `quarantined`   | not a failure: a reviewer decides (ADR-0086)             |
 * | `unknown`, none | yes: a row from before the category, or one nothing      |
 * |                 | recognised, keeps the behaviour it always had            |
 *
 * A row that is not FAILED is not this module's business and always passes:
 * an indexed document re-read on purpose, a row stranded at `uploaded`, a
 * stuck in-flight row (`reingestDocument` has its own guards for those).
 *
 * Nothing retries a failed document on its own. The one sweep there is
 * (`./stuck-processing`) recovers rows left at `processing`, never `failed`,
 * and an automatic retry of failures would spend vision calls nobody asked
 * for. `ingest_attempts` is recorded on every dispatch so that one could be
 * capped if it is ever added; today it is a fact for people, not an input.
 *
 * Pure, no `server-only`: the listing projection, the service and the specs
 * import it, and the SQL twin (`retryRefusedSql` in `./repository`) states the
 * same rule for the queries that select what a bulk retry sends.
 */

import { documentReadFamily } from './document-status'

/**
 * The categories the backend writes (`FAILURE_CATEGORIES` in
 * `ingest_failures.py`). `tests/knowledge_layer_tests/test_ingest_failure_prefix_parity.py`
 * parses this list: keep it one quoted value per entry.
 */
export const INGEST_FAILURE_CATEGORIES = ['transient', 'configuration', 'deterministic', 'quarantined', 'unknown'] as const

export type IngestFailureCategory = (typeof INGEST_FAILURE_CATEGORIES)[number]

/**
 * The reader the deployed backend reads with (`INGEST_READER_VERSION` in
 * `sources/knowledge_layer/src/reader_version.py`, which states when to raise
 * it). Mirrored rather than asked for, so deciding a retry costs no backend
 * call; the parity test fails when the two disagree.
 */
export const CURRENT_INGEST_READER_VERSION = '2026.10.1'

/**
 * What one finished job said about its file, as the reconcile carries it to
 * the row (`setDocumentReconciledStatus`). All null for a job that said
 * nothing: an older backend, a completed file, or a failure the BFF found
 * without a job.
 */
export interface IngestFailureFacts {
  category: IngestFailureCategory | null
  retryable: boolean | null
  readerVersion: string | null
}

/** The facts the rule reads off a document row. Absent is the same as null: not recorded. */
export interface RetryFacts {
  status: string | null
  ingestFailureCategory?: string | null
  ingestRetryable?: boolean | null
  ingestReaderVersion?: string | null
}

export interface RetryContext {
  /** The reader the backend reads with now; {@link CURRENT_INGEST_READER_VERSION} in production. */
  currentReaderVersion: string
  /** Whether the row's bytes differ from the bytes the failed attempt read ({@link contentHashChanged}). */
  contentHashChanged: boolean
}

/** A stored category, or null for one this build does not know (written by a newer backend, say). */
export function parseIngestFailureCategory(value: unknown): IngestFailureCategory | null {
  return typeof value === 'string' && (INGEST_FAILURE_CATEGORIES as readonly string[]).includes(value)
    ? (value as IngestFailureCategory)
    : null
}

/** `2026.10.1` as `[2026, 10, 1]`, or null when it is not dotted numbers. */
function readerVersionParts(version: string): number[] | null {
  if (!/^\d+(\.\d+)*$/.test(version)) return null
  return version.split('.').map(Number)
}

/**
 * Whether `current` is a newer reader than `failed`. Compared part by part as
 * numbers (`2026.10.1` is newer than `2026.9.4`). A failure with no recorded
 * reader, or one that does not parse, counts as older: what is not known
 * cannot hold a retry back.
 */
export function isNewerReader(current: string, failed: string | null | undefined): boolean {
  if (!failed) return true
  const a = readerVersionParts(current)
  const b = readerVersionParts(failed)
  if (!a || !b) return current !== failed
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * Whether the row holds different bytes from the ones its last dispatch sent:
 * `contentHash` against the `ingestContentHash` the dispatch recorded
 * (`setDocumentIngestJob`). Unknown on either side is "not changed": a row
 * without a recorded digest proves nothing about its bytes.
 */
export function contentHashChanged(row: { contentHash?: string | null; metadata?: unknown }): boolean {
  const dispatched =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as { ingestContentHash?: unknown }).ingestContentHash
      : undefined
  return (
    typeof dispatched === 'string' &&
    dispatched.length > 0 &&
    typeof row.contentHash === 'string' &&
    row.contentHash.length > 0 &&
    row.contentHash !== dispatched
  )
}

/** Whether reading this document again may come out differently. See the module header. */
export function canRetry(doc: RetryFacts, context: RetryContext): boolean {
  if (documentReadFamily(doc.status) !== 'failed') return true
  const category = parseIngestFailureCategory(doc.ingestFailureCategory)
  if (category === 'deterministic') {
    return context.contentHashChanged || isNewerReader(context.currentReaderVersion, doc.ingestReaderVersion)
  }
  if (category === null) return doc.ingestRetryable !== false
  // The category decides, not the flag beside it: the two are written
  // together, and a known category is the more specific of the two.
  return category !== 'quarantined'
}

/** {@link canRetry} for a stored row, against the deployed reader. */
export function canRetryRow(
  row: RetryFacts & { contentHash?: string | null; metadata?: unknown }
): boolean {
  return canRetry(row, {
    currentReaderVersion: CURRENT_INGEST_READER_VERSION,
    contentHashChanged: contentHashChanged(row),
  })
}

/**
 * The documents of a list a bulk retry offers and sends: every one the listing
 * did not mark `retryable: false`. A document named without the flag (a
 * summary-built brief names ids only, already filtered by the server) is kept.
 */
export function offeredForRetry<T extends object>(documents: readonly T[]): T[] {
  return documents.filter((document) => (document as Record<string, unknown>).retryable !== false)
}
