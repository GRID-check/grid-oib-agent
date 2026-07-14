/**
 * Storage-convergence reconciler — the pure diff core (ADR-0024).
 *
 * GRID keeps four stores convergent: the drive view (= S3), the `documents`
 * index, the S3 bytes, and the ChromaDB vectors the agent queries. The
 * reconciler is the PRIMARY mechanism that makes the knowledge system agree
 * with whatever is in S3, regardless of how a file got there (web upload, drive
 * write, or API) — see docs/adr/0024.
 *
 * This module is that reconciler's brain, factored out as a **pure function** so
 * the distributed-consistency logic — the part that corrupts state if it is
 * wrong — is exhaustively unit-testable with no Postgres, S3, or Python. It
 * takes an S3 listing + the live `documents` rows + the clock and returns an
 * ordered, deterministic PLAN of intents. Everything effectful (claiming rows,
 * calling `/v1/ingest`, `ingestor.delete_file`, enqueuing into `deletion_queue`)
 * lives in the worker that executes the plan; nothing here performs I/O.
 *
 * The convergence direction is S3 -> `documents` -> vectors. All five ADR-0024
 * §2 guards against acting on transient state are enforced here and nowhere
 * else:
 *
 *   1. Name filter        — never reconcile temp/lock artifacts (`isIgnoredName`).
 *   2. Quiescence         — act only on objects settled past `settleWindowMs`.
 *   3. ETag change-detect  — re-ingest only when the recorded ETag differs.
 *   4. Deletion grace      — treat an object-less row as a delete only once the
 *                            row is older than `deletionGraceMs` (defends the
 *                            web-upload race: row is written before PutObject).
 *   5. Pipeline backstop   — a deletion is emitted as an *enqueue* intent, never
 *                            a hard delete; the worker routes it through the
 *                            ADR-0011 deletion pipeline (grace + legal holds).
 */

/** DB ingestion statuses (documents.status). Terminal success is 'completed'. */
export type IngestStatus =
  | 'uploaded'
  | 'pending'
  | 'processing'
  | 'ingesting'
  | 'completed'
  | 'failed'

/** DB statuses that mean "ingestion outcome not yet reached" (still needs work). */
const NON_TERMINAL_STATUSES = new Set<IngestStatus>([
  'uploaded',
  'pending',
  'processing',
  'ingesting',
  'failed',
])

/** One settled object from S3 ListObjectsV2, projected to what the diff needs. */
export interface ObjectListing {
  key: string
  /** Opaque per-version identity (the ListObjectsV2 ETag). Quotes are normalized. */
  etag: string
  /** Epoch millis of the object's S3 LastModified. */
  lastModifiedMs: number
  size: number
}

/**
 * A live (NOT soft-deleted) `documents` row, projected to what the diff needs.
 * Callers must pass only rows with `deletedAt IS NULL`: soft-deleted rows are
 * already owned by the deletion pipeline and must not re-enter convergence.
 */
export interface DocumentRow {
  documentId: string
  objectKey: string
  /** ETag captured at the last successful ingest; null if never ingested (or a legacy row). */
  recordedEtag: string | null
  status: IngestStatus
  /** Epoch millis of the row's createdAt. */
  createdAtMs: number
  /** Ingest attempts so far (same poison-guard semantics as deletion_queue.attempts). */
  attempts: number
}

export interface ReconcileConfig {
  /** Objects modified within this window are still settling; skip them this sweep. */
  settleWindowMs: number
  /** A row whose object is absent is a deletion only once older than this. */
  deletionGraceMs: number
  /** Stop (re)dispatching a non-completed doc after this many attempts (poison guard). */
  maxAttempts: number
}

export const DEFAULT_RECONCILE_CONFIG: ReconcileConfig = {
  // A drive save is a temp-write then a rename; 30s lets that sequence finish.
  settleWindowMs: 30_000,
  // The web path writes the row BEFORE PutObject; a fresh object-less row is an
  // upload in flight, not a deletion. Comfortably longer than a large PUT.
  deletionGraceMs: 5 * 60_000,
  // Mirrors purger MAX_ATTEMPTS: a doc that fails this many times is poison,
  // surfaced for an admin rather than retried forever.
  maxAttempts: 10,
}

export type ReconcileAction =
  /** S3 object with no live row: create the row + dispatch first ingest. */
  | { type: 'ingest-new'; objectKey: string; etag: string }
  /**
   * A completed row that has no baseline ETag (a legacy row ingested before ETag
   * tracking): adopt the current ETag as the baseline WITHOUT re-ingesting — its
   * embeddings are assumed current as of completion. This closes the otherwise
   * silent gap where such a row could never detect a future content change.
   */
  | { type: 'adopt-etag'; documentId: string; objectKey: string; etag: string }
  /**
   * Content changed (recorded ETag differs): delete the old embeddings
   * (`ingestor.delete_file`) THEN re-ingest — the oib_sync delete-then-reingest
   * sequence, so stale vectors never linger.
   */
  | { type: 'reingest-changed'; documentId: string; objectKey: string; oldEtag: string; newEtag: string }
  /** Row present, bytes unchanged, but not yet completed and attempts remain: (re)dispatch ingest. */
  | { type: 'retry-ingest'; documentId: string; objectKey: string; etag: string; attempts: number }
  /** Live row whose S3 object is gone and past the grace window: route into the deletion pipeline. */
  | { type: 'enqueue-deletion'; documentId: string; objectKey: string }

export type SkipReason =
  | 'ignored-name' // guard 1: temp/lock artifact (or a folder placeholder)
  | 'not-quiescent' // guard 2: object still settling
  | 'up-to-date' // completed + unchanged: nothing to do
  | 'attempts-exhausted' // poison guard: non-completed past maxAttempts
  | 'deletion-grace' // guard 4: object-less row too young to be a deletion
  | 'duplicate-row' // a non-canonical row for a key that has several live rows

/**
 * A non-action, emitted so a sweep's decision for every input is observable
 * (metrics/logs/tests) rather than silently absent. Skips never mutate state.
 */
export interface ReconcileSkip {
  type: 'skip'
  reason: SkipReason
  objectKey: string
  documentId?: string
}

export interface ReconcilePlan {
  actions: ReconcileAction[]
  skips: ReconcileSkip[]
}

/**
 * Names the reconciler must never treat as documents: application temp/lock
 * files (which AEC and Office apps write constantly), OS metadata, partial
 * uploads, and S3 "folder" placeholder keys (trailing slash). Matched on the
 * object's basename. Kept deliberately broad — a false *positive* only delays a
 * real file to the next sweep, while a false *negative* ingests a lock file as
 * knowledge.
 */
export function isIgnoredName(key: string): boolean {
  // Folder placeholder object (e.g. "org/o/project/p/folder/") — not a file.
  if (key.endsWith('/')) return true

  const base = key.slice(key.lastIndexOf('/') + 1)
  if (base === '') return true
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true

  // Prefixes.
  if (base.startsWith('~$')) return true // Office owner/lock files (~$doc.docx)
  if (base.startsWith('.~lock')) return true // LibreOffice (.~lock.file#)
  if (base.startsWith('._')) return true // macOS AppleDouble

  // Suffixes.
  const lower = base.toLowerCase()
  if (
    lower.endsWith('.tmp') ||
    lower.endsWith('.temp') ||
    lower.endsWith('.partial') || // rclone/VFS partial writes
    lower.endsWith('.crdownload') ||
    lower.endsWith('.bak') ||
    lower.endsWith('.swp') ||
    lower.endsWith('.ac$') || // AutoCAD temp (drawing_1_1_XXXX.ac$)
    lower.endsWith('.sv$') || // AutoCAD autosave
    lower.endsWith('.dwl') ||
    lower.endsWith('.dwl2')
  ) {
    return true
  }
  return false
}

/** Strip surrounding quotes/whitespace so `"abc"` and `abc` compare equal. */
function normalizeEtag(etag: string | null): string | null {
  if (etag == null) return null
  const trimmed = etag.trim().replace(/^"+|"+$/g, '')
  return trimmed === '' ? null : trimmed
}

/**
 * An object is quiescent once it has been untouched for longer than the settle
 * window. A LastModified in the future (clock skew) is treated as NOT quiescent
 * — the safe direction, since acting on a still-settling object is the harm.
 */
function isQuiescent(obj: ObjectListing, nowMs: number, settleWindowMs: number): boolean {
  const age = nowMs - obj.lastModifiedMs
  return age >= settleWindowMs
}

/**
 * Choose one canonical row per object key so the plan is deterministic even if a
 * key somehow has several live rows (the `(projectId, objectKey)` unique index
 * from ADR-0024 should prevent this, but the pure function must not depend on a
 * DB invariant it can't see). Oldest `createdAt` wins, ties broken by documentId
 * so the choice is independent of input ordering; the losers are reported as
 * `duplicate-row` skips for an operator to reconcile.
 */
function canonicalizeRows(rows: DocumentRow[]): {
  byKey: Map<string, DocumentRow>
  duplicateSkips: ReconcileSkip[]
} {
  const groups = new Map<string, DocumentRow[]>()
  for (const row of rows) {
    const g = groups.get(row.objectKey)
    if (g) g.push(row)
    else groups.set(row.objectKey, [row])
  }

  const byKey = new Map<string, DocumentRow>()
  const duplicateSkips: ReconcileSkip[] = []
  for (const [key, group] of groups) {
    if (group.length === 1) {
      byKey.set(key, group[0])
      continue
    }
    const sorted = [...group].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0),
    )
    byKey.set(key, sorted[0])
    for (const dup of sorted.slice(1)) {
      duplicateSkips.push({ type: 'skip', reason: 'duplicate-row', objectKey: key, documentId: dup.documentId })
    }
  }
  return { byKey, duplicateSkips }
}

const ACTION_ORDER: Record<ReconcileAction['type'], number> = {
  'enqueue-deletion': 0,
  'reingest-changed': 1,
  'ingest-new': 2,
  'retry-ingest': 3,
  'adopt-etag': 4,
}

/**
 * Compute the convergence plan for one sweep: a pure, deterministic diff of an
 * S3 listing against the live `documents` rows. No I/O, no clock read — `nowMs`
 * and every threshold are injected — so the same inputs always yield the same
 * plan (which is what makes it exhaustively testable and safe to re-run).
 *
 * @param objects  S3 ListObjectsV2 result for the swept prefix (may include temp/folder keys).
 * @param rows     LIVE documents rows for the same prefix (deletedAt IS NULL).
 * @param nowMs    The sweep's wall clock, epoch millis.
 * @param config   Guard thresholds (defaults: DEFAULT_RECONCILE_CONFIG).
 */
export function reconcilePlan(
  objects: ObjectListing[],
  rows: DocumentRow[],
  nowMs: number,
  config: ReconcileConfig = DEFAULT_RECONCILE_CONFIG,
): ReconcilePlan {
  const actions: ReconcileAction[] = []
  const skips: ReconcileSkip[] = []

  // Guard 1: name filter. `rawKeys` keeps EVERY key seen from S3 (even ignored
  // ones) so a row pointing at a present-but-ignored object is not mistaken for
  // a deletion below; `objByKey` holds only the reconcilable objects.
  const rawKeys = new Set<string>()
  const objByKey = new Map<string, ObjectListing>()
  for (const obj of objects) {
    rawKeys.add(obj.key)
    if (isIgnoredName(obj.key)) {
      skips.push({ type: 'skip', reason: 'ignored-name', objectKey: obj.key })
      continue
    }
    // Last write wins if S3 somehow lists a key twice; harmless for the diff.
    objByKey.set(obj.key, { ...obj, etag: normalizeEtag(obj.etag) ?? '' })
  }

  const { byKey: rowByKey, duplicateSkips } = canonicalizeRows(rows)
  skips.push(...duplicateSkips)

  // --- Arrived / changed / not-yet-ingested: objects present in S3 ---
  for (const [key, obj] of objByKey) {
    const row = rowByKey.get(key)
    const quiescent = isQuiescent(obj, nowMs, config.settleWindowMs)

    if (!row) {
      // Arrived: an object with no live row.
      if (!quiescent) {
        skips.push({ type: 'skip', reason: 'not-quiescent', objectKey: key })
        continue
      }
      actions.push({ type: 'ingest-new', objectKey: key, etag: obj.etag })
      continue
    }

    const recorded = normalizeEtag(row.recordedEtag)

    if (recorded !== null && recorded !== obj.etag) {
      // Guard 3: content changed. Wait for the NEW bytes to settle (guard 2)
      // before replacing embeddings, then delete-then-reingest.
      if (!quiescent) {
        skips.push({ type: 'skip', reason: 'not-quiescent', objectKey: key, documentId: row.documentId })
        continue
      }
      actions.push({
        type: 'reingest-changed',
        documentId: row.documentId,
        objectKey: key,
        oldEtag: recorded,
        newEtag: obj.etag,
      })
      continue
    }

    if (row.status === 'completed') {
      if (recorded === null) {
        // Legacy completed row with no baseline: adopt the current ETag so a
        // FUTURE change is detectable. No settle wait — we only record metadata.
        actions.push({ type: 'adopt-etag', documentId: row.documentId, objectKey: key, etag: obj.etag })
      } else {
        skips.push({ type: 'skip', reason: 'up-to-date', objectKey: key, documentId: row.documentId })
      }
      continue
    }

    // Non-terminal (uploaded/pending/processing/ingesting/failed), bytes match.
    if (NON_TERMINAL_STATUSES.has(row.status)) {
      if (row.attempts >= config.maxAttempts) {
        skips.push({ type: 'skip', reason: 'attempts-exhausted', objectKey: key, documentId: row.documentId })
        continue
      }
      if (!quiescent) {
        skips.push({ type: 'skip', reason: 'not-quiescent', objectKey: key, documentId: row.documentId })
        continue
      }
      actions.push({
        type: 'retry-ingest',
        documentId: row.documentId,
        objectKey: key,
        etag: obj.etag,
        attempts: row.attempts,
      })
    }
  }

  // --- Disappeared: live rows whose object is gone (guards 4 & 5) ---
  for (const [key, row] of rowByKey) {
    if (rawKeys.has(key)) continue // object present (possibly ignored) — not a deletion
    // Guard 4: an object-less row younger than the grace window is an upload in
    // flight (the row is written before PutObject), not a deletion.
    if (nowMs - row.createdAtMs < config.deletionGraceMs) {
      skips.push({ type: 'skip', reason: 'deletion-grace', objectKey: key, documentId: row.documentId })
      continue
    }
    // Guard 5: emit an ENQUEUE intent, never a hard delete. The worker routes it
    // through the ADR-0011 pipeline, which re-checks legal holds and applies the
    // undo/grace window before any bytes or embeddings are destroyed.
    actions.push({ type: 'enqueue-deletion', documentId: row.documentId, objectKey: key })
  }

  // Deterministic order: deletions first (reclaim), then content replacement,
  // new ingests, retries, metadata adoptions; ties broken by object key.
  actions.sort((a, b) => ACTION_ORDER[a.type] - ACTION_ORDER[b.type] || (a.objectKey < b.objectKey ? -1 : 1))
  skips.sort((a, b) => (a.objectKey < b.objectKey ? -1 : a.objectKey > b.objectKey ? 1 : 0))

  return { actions, skips }
}

/** Roll a plan up to counts for a single structured log line per sweep. */
export function summarizePlan(plan: ReconcilePlan): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const a of plan.actions) counts[a.type] = (counts[a.type] ?? 0) + 1
  for (const s of plan.skips) counts[`skip:${s.reason}`] = (counts[`skip:${s.reason}`] ?? 0) + 1
  return counts
}
