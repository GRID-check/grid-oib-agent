/**
 * Platform maintenance: reconcile orphaned vectors (ADR-0016).
 *
 * Deleting a document is a two-step cleanup — drop the Chroma chunks, then the
 * Postgres row. When the chunk delete was skipped or missed (historically: a
 * filename that was persisted percent-encoded at ingest time never matched the
 * raw name sent at delete time), the row went away but the vectors stayed. Such
 * chunks are invisible to the UI yet still surface in retrieval.
 *
 * This sweep recovers them. Postgres `documents` is the source of truth for
 * what should exist; any chunk whose owning document no longer has a row is an
 * orphan and is deleted from the vector store.
 *
 * Cross-org and destructive — caller authorization (requirePlatformOwner)
 * happens in the route; this module is data-only and must never be exposed to a
 * tenant session.
 */

import 'server-only'
import { getDb } from '@/lib/db'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { documents } from '@/lib/db/schema'
import { getBackendUrl } from '@/lib/backend-proxy'

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
  /** Per-collection failures; the sweep continues past them. */
  failures: { collectionName: string; error: string }[]
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
 * Scan every live collection and delete chunks whose owning document row is
 * gone. Idempotent: a clean store deletes nothing. Compares the DECODED stored
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
    failures: [],
  }

  for (const [collectionName, liveNames] of live) {
    result.collectionsScanned += 1
    try {
      const stored = await listStoredFilenames(collectionName)
      // Orphan = a stored chunk name whose decoded form has no live row.
      const orphans = stored.filter((name) => !liveNames.has(safeDecode(name)))
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

  return result
}
