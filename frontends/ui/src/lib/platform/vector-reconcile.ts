/**
 * Platform maintenance: reconcile orphaned vectors (ADR-0016).
 *
 * Deleting a document is a two-step cleanup — drop the vector-store chunks, then the
 * Postgres row. When the chunk delete was skipped or missed (historically: a
 * filename that was persisted percent-encoded at ingest time never matched the
 * raw name sent at delete time), the row went away but the vectors stayed. Such
 * chunks are invisible to the UI yet still surface in retrieval.
 *
 * This sweep recovers them. Postgres `documents` is the source of truth for
 * what should exist; any chunk whose owning document no longer has a row is an
 * orphan and is deleted from the vector store.
 *
 * The chunks have a mirror image: a summary row (the backend's
 * `document_metadata` table, which the agent's document inventory is built
 * from) whose chunks are gone. Deleting a file used to leave that row behind
 * when the chunk delete found nothing, so the agent kept listing a file it
 * could not read. The backend forgets both together now; the rows orphaned
 * before it did are swept here too, as the second half of the same run, by
 * the backend's own `reconcile-summaries` route — the summaries table is not
 * this tier's to read.
 *
 * Two more halves repair the facts copied onto the chunks, whose authority is
 * Postgres: every project's facts and status (`syncAllProjectFacts`), and every
 * document's person-set facts (tags, Dokumentart, the superseded mark, the
 * folder) through the backend's `refresh-document-facts` route. Both copies
 * are made after each change and never fail the change, so this weekly pass is
 * what puts right a copy that failed.
 *
 * Cross-org and destructive — caller authorization (requirePlatformPermission)
 * happens in the route; this module is data-only and must never be exposed to a
 * tenant session.
 */

import 'server-only'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { documents } from '@/lib/db/schema'
import { getBackendUrl } from '@/lib/backend-proxy'
import { syncAllProjectFacts, type ProjectFactsSyncResult } from '@/lib/cross-project/project-facts-mirror'

// Reconcile touches whole collections; give each backend call more room than a
// per-request timeout since a large collection's file list can be sizeable.
const BACKEND_FETCH_TIMEOUT_MS = 15_000

export interface VectorReconcileResult {
  /** Live collections scanned (those with at least one document row). */
  collectionsScanned: number
  /** Orphaned chunk-groups (files) found with no owning document row. */
  orphansFound: number
  /** Chunks actually removed from the vector store. */
  orphansDeleted: number
  /**
   * Summary rows forgotten because their file holds no chunks (the second
   * half of the sweep, run by the backend over the same collections).
   */
  summariesForgotten: number
  /**
   * Per-collection failures; the sweep continues past them. A failure of the
   * summary half as a whole (the backend refused or could not be reached) is
   * one entry under {@link SUMMARY_SWEEP_FAILURE_NAME}, since it names no
   * single collection.
   */
  failures: { collectionName: string; error: string }[]
  /** The facts copy of every project onto its chunks (the third half); absent when it could not run. */
  projectFacts?: ProjectFactsSyncResult
  /** The facts copy of every document onto its chunks (the fourth half). */
  documentFacts?: DocumentFactsRefreshResult
}

/** What the document facts half did. */
export interface DocumentFactsRefreshResult {
  /** Collections whose documents' facts were copied again. */
  collections: number
  /** Files whose facts were copied. */
  files: number
  /** True when the deployment writes no Qdrant: the half stopped at the first answer saying so. */
  unsupported: boolean
}

/** The `collectionName` a whole-sweep summary failure is filed under. */
export const SUMMARY_SWEEP_FAILURE_NAME = '*'
/** The `collectionName` a failure of the project facts half as a whole is filed under. */
export const PROJECT_FACTS_FAILURE_NAME = '*project-facts'

/**
 * Collections per `refresh-document-facts` call. The backend accepts at most
 * 100 (`REFRESH_FACTS_MAX_COLLECTIONS`); a smaller batch keeps one call well
 * inside {@link DOCUMENT_FACTS_TIMEOUT_MS} for collections of many files.
 */
export const DOCUMENT_FACTS_BATCH = 25
/** One batch's bound: each file's Dokumentart may cost the backend one read. */
const DOCUMENT_FACTS_TIMEOUT_MS = 120_000

/** The backend's `POST /v1/maintenance/reconcile-summaries` answer. */
interface BackendSummaryReconcile {
  orphans_forgotten?: number
  forgotten?: { collection: string; file_name: string }[]
  failures?: { collection: string; error: string }[]
}

interface BackendFileInfo {
  file_name?: string
}

/**
 * URL-decode a stored chunk `file_name`, tolerating a name that is not encoded
 * (or is malformed). The vector store may hold names in either form: encoded
 * (documents ingested before the ingest-time decode fix) or already decoded.
 */
function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/**
 * Every live collection mapped to the set of filenames that still have a
 * `documents` row (any status — a pending/failed row still means the document
 * exists and must not be treated as an orphan). Collections with no rows at all
 * — e.g. the separately-managed OIB base corpus, or a fully-purged project —
 * are absent by construction and are never touched by the sweep.
 *
 * ## A machine-authored row keeps its collection, but contributes no live name
 *
 * The two halves of that map answer two different questions, and an
 * agent-authored row answers only one of them.
 *
 * It answers "is this collection still in use" — yes, the project exists, and a
 * collection dropping out of the map is how the sweep stops touching a purged
 * project. So the row keeps its collection scanned. Losing that would be a
 * REGRESSION in cleanup: a project whose human uploads were all deleted but
 * which still holds one of Piloti's reports would stop being swept entirely,
 * and the orphaned chunks of those deleted uploads — the exact thing this
 * module exists to recover — would survive forever.
 *
 * It does NOT answer "which filenames legitimately own chunks here". Nothing
 * machine-authored is ever dispatched to `/v1/ingest` (see
 * `lib/documents/service.ts`'s dispatch guard), so an agent row owns no chunks
 * by construction, and a stored chunk carrying its filename is never explained
 * by it. Letting it into the live set makes it a SHIELD: the orphaned chunks of
 * a deleted document stay in retrieval because an unrelated row happens to
 * share their name.
 *
 * That collision is reachable, not theoretical. `generatedFilename` builds
 * `slug(title)-YYYY-MM-DD.ext` from a title the model itself wrote, so a report
 * about a Sicherheitskonzept lands on the filename of the Sicherheitskonzept it
 * was written from. The failure is quiet and it defeats deletion: somebody
 * deletes a document, the chunk delete misses (the historical bug in the header
 * comment), the recovery sweep is disarmed by a name collision, and the deleted
 * document keeps answering questions. For a file removed on legal instruction
 * that is the worst version of this bug.
 *
 * The rule is the one three other call sites now hold: filename is not an
 * identity across authorship. Ask the row.
 */
async function liveFilenamesByCollection(): Promise<Map<string, Set<string>>> {
  const db = getDb()
  const rows = (await withPlatformAccess(
    'vector reconciliation sweep: every collection in the deployment, across organizations',
    () =>
      db
        .select({
          collectionName: documents.collectionName,
          filename: documents.filename,
          authoredBy: documents.authoredBy,
        })
        .from(documents),
    // `authoredBy` is REQUIRED here, and the select two lines up is why it can
    // be: an optional field would keep alive a branch for a column that is
    // always present, and a dead branch in this function is a dead branch in a
    // sweep that deletes chunks.
  )) as { collectionName: string; filename: string; authoredBy: string }[]

  const byCollection = new Map<string, Set<string>>()
  for (const row of rows) {
    let names = byCollection.get(row.collectionName)
    if (!names) {
      names = new Set<string>()
      byCollection.set(row.collectionName, names)
    }
    // Only a human-authored row shields a filename from the sweep. A machine-
    // authored row owns no chunks, so treating one as live would disarm the
    // recovery sweep for whatever human document shares its name.
    //
    // Note the polarity is the OPPOSITE of the document search join, which is
    // why the two must not be described as one rule. There, admitting an
    // unknown authorship SHOWS a machine-authored row to a reader; here, it
    // KEEPS a chunk that might be a human document's. So search fails closed on
    // anything that is not `user`, and this fails safe on it — and the reason
    // neither has to make that choice at runtime is that both require the
    // column, so "unknown authorship" is a compile error rather than a branch.
    if (row.authoredBy === 'user') names.add(row.filename)
  }
  return byCollection
}

/**
 * The filenames one collection's human-authored rows hold NOW: the second look
 * before its orphans are deleted. The snapshot ({@link liveFilenamesByCollection})
 * is taken once, before a sweep that can run for minutes, and a document filed
 * in between has a row and chunks the snapshot never saw. Same authorship rule
 * as the snapshot.
 */
async function liveFilenamesIn(collectionName: string): Promise<Set<string>> {
  const db = getDb()
  const rows = (await withPlatformAccess(
    'vector reconciliation sweep: re-reading one collection before deleting its orphans',
    () =>
      db
        .select({ filename: documents.filename, authoredBy: documents.authoredBy })
        .from(documents)
        .where(eq(documents.collectionName, collectionName)),
  )) as { filename: string; authoredBy: string }[]
  return new Set(rows.filter((row) => row.authoredBy === 'user').map((row) => row.filename))
}

/** Distinct stored `file_name` values the vector store holds for a collection. */
async function listStoredFilenames(collectionName: string): Promise<string[]> {
  const res = await fetch(
    `${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/documents`,
    { signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS) },
  )
  if (!res.ok) throw new Error(`list returned ${res.status}`)
  const body = (await res.json()) as BackendFileInfo[]
  if (!Array.isArray(body)) return []
  return body.map((file) => file.file_name).filter((name): name is string => typeof name === 'string' && name.length > 0)
}

/** Delete the given files' chunks; returns how many chunks the backend removed. */
async function deleteChunks(collectionName: string, fileIds: string[]): Promise<number> {
  const res = await fetch(
    `${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/documents`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: fileIds }),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    },
  )
  if (!res.ok) throw new Error(`delete returned ${res.status}`)
  const body = (await res.json().catch(() => ({}))) as { total_deleted?: number }
  return typeof body.total_deleted === 'number' ? body.total_deleted : 0
}

/**
 * Forget summary rows whose chunks are gone, in the given collections only.
 *
 * The backend does the comparison: it holds the summaries table and the
 * vector store, and it already knows the two spellings a chunk name can be
 * stored under. Internal-token guarded, like every other BFF → backend call
 * that is not a user's own request (`lib/knowledge/embeddings.ts` is the
 * pattern). Scoped to the collections the chunk half just walked, so the
 * separately managed OIB corpus is never touched from here.
 */
async function reconcileOrphanedSummaries(
  collectionNames: string[],
): Promise<Pick<VectorReconcileResult, 'summariesForgotten' | 'failures'>> {
  if (collectionNames.length === 0) return { summariesForgotten: 0, failures: [] }
  const res = await fetch(`${getBackendUrl()}/v1/maintenance/reconcile-summaries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-grid-internal-token': process.env.GRID_INTERNAL_API_TOKEN ?? '',
    },
    body: JSON.stringify({ collections: collectionNames, dry_run: false }),
    signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`reconcile-summaries returned ${res.status}`)
  const body = (await res.json().catch(() => ({}))) as BackendSummaryReconcile
  return {
    summariesForgotten: typeof body.orphans_forgotten === 'number' ? body.orphans_forgotten : 0,
    failures: (body.failures ?? []).map((failure) => ({
      collectionName: failure.collection,
      error: `summary reconcile: ${failure.error}`,
    })),
  }
}

/** The backend's `POST /v1/maintenance/refresh-document-facts` answer. */
interface BackendDocumentFactsRefresh {
  collections_scanned?: number
  files_refreshed?: number
  failures?: { collection: string; error: string }[]
}

/**
 * Copy every document's person-set facts (tags, Dokumentart, the superseded
 * mark, the folder) onto its chunks again, in bounded batches of the
 * collections the chunk half walked. The copy after an edit
 * (`writes.refresh_facts`) never raises, so one that failed left the old value
 * on the points, and the pre-filters reading it (the cross-project search's
 * tag filters, the superseded exclusion) hide or show the document wrongly
 * until this runs. A batch that fails is recorded under each of its
 * collections and the next batch still runs; a 409 (no Qdrant here) stops the
 * half, as the project facts half stops.
 */
async function refreshDocumentFacts(
  collectionNames: string[],
): Promise<{ result: DocumentFactsRefreshResult; failures: VectorReconcileResult['failures'] }> {
  const result: DocumentFactsRefreshResult = { collections: 0, files: 0, unsupported: false }
  const failures: VectorReconcileResult['failures'] = []
  for (let start = 0; start < collectionNames.length; start += DOCUMENT_FACTS_BATCH) {
    const batch = collectionNames.slice(start, start + DOCUMENT_FACTS_BATCH)
    try {
      const res = await fetch(`${getBackendUrl()}/v1/maintenance/refresh-document-facts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-grid-internal-token': process.env.GRID_INTERNAL_API_TOKEN ?? '',
        },
        body: JSON.stringify({ collections: batch }),
        signal: AbortSignal.timeout(DOCUMENT_FACTS_TIMEOUT_MS),
      })
      if (res.status === 409) return { result: { ...result, unsupported: true }, failures }
      if (!res.ok) throw new Error(`refresh-document-facts returned ${res.status}`)
      const body = (await res.json().catch(() => ({}))) as BackendDocumentFactsRefresh
      result.collections += typeof body.collections_scanned === 'number' ? body.collections_scanned : 0
      result.files += typeof body.files_refreshed === 'number' ? body.files_refreshed : 0
      failures.push(
        ...(body.failures ?? []).map((failure) => ({
          collectionName: failure.collection,
          error: `document facts: ${failure.error}`,
        })),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      failures.push(...batch.map((collectionName) => ({ collectionName, error: `document facts: ${message}` })))
    }
  }
  return { result, failures }
}

/**
 * Scan every live collection and delete chunks whose owning document row is
 * gone, then forget the summary rows those collections hold for files with no
 * chunks. Idempotent: a clean store deletes nothing. Compares the DECODED stored
 * name against live filenames, so a live document persisted under an encoded
 * name (the historical bug) is correctly recognised as live and its vectors are
 * never deleted.
 */
export async function reconcileOrphanedVectors(): Promise<VectorReconcileResult> {
  const live = await liveFilenamesByCollection()
  const result: VectorReconcileResult = {
    collectionsScanned: 0,
    orphansFound: 0,
    orphansDeleted: 0,
    summariesForgotten: 0,
    failures: [],
  }

  for (const [collectionName, liveNames] of live) {
    result.collectionsScanned += 1
    try {
      const stored = await listStoredFilenames(collectionName)
      // Orphan = a stored chunk name whose decoded form has no live row, in
      // the snapshot AND on a second look right before the delete.
      const candidates = stored.filter((name) => !liveNames.has(safeDecode(name)))
      if (candidates.length === 0) continue
      const liveNow = await liveFilenamesIn(collectionName)
      const orphans = candidates.filter((name) => !liveNow.has(safeDecode(name)))
      if (orphans.length === 0) continue
      result.orphansFound += orphans.length
      // Delete by the exact stored name so the backend's exact-match path hits
      // regardless of whether that name is encoded or already decoded.
      result.orphansDeleted += await deleteChunks(collectionName, orphans)
    } catch (error) {
      result.failures.push({
        collectionName,
        error: error instanceof Error ? error.message : 'unknown error',
      })
    }
  }

  // Second half, AFTER the chunk pass: deleting a file's chunks above already
  // forgets its summary on the backend, so what is left for this call is
  // exactly the rows orphaned before the backend learned to do that. Its
  // failure is recorded like any collection's and never undoes the chunk half.
  try {
    const summaries = await reconcileOrphanedSummaries([...live.keys()])
    result.summariesForgotten = summaries.summariesForgotten
    result.failures.push(...summaries.failures)
  } catch (error) {
    result.failures.push({
      collectionName: SUMMARY_SWEEP_FAILURE_NAME,
      error: `summary reconcile: ${error instanceof Error ? error.message : 'unknown error'}`,
    })
  }

  // Third half: every project's facts onto its chunks (design §4, "Mutable
  // facts"). Repairs a copy a profile save or a lifecycle move failed to push,
  // and fills chunks the Qdrant backfill copied in without them. A no-op on a
  // deployment that does not write Qdrant.
  try {
    result.projectFacts = await syncAllProjectFacts()
  } catch (error) {
    result.failures.push({
      collectionName: PROJECT_FACTS_FAILURE_NAME,
      error: `project facts: ${error instanceof Error ? error.message : 'unknown error'}`,
    })
  }

  // Fourth half: every document's facts onto its chunks again, over the same
  // live collections. Repairs a copy an edit failed to make; never throws.
  const documentFacts = await refreshDocumentFacts([...live.keys()])
  result.documentFacts = documentFacts.result
  result.failures.push(...documentFacts.failures)

  return result
}
