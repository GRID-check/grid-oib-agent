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
 * Cross-org and destructive — caller authorization (requirePlatformPermission)
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
 */
async function liveFilenamesByCollection(): Promise<Map<string, Set<string>>> {
  const db = getDb()
  const rows = (await withPlatformAccess(
    'vector reconciliation sweep: every collection in the deployment, across organizations',
    () => db.select({ collectionName: documents.collectionName, filename: documents.filename }).from(documents),
  )) as { collectionName: string; filename: string }[]

  const byCollection = new Map<string, Set<string>>()
  for (const row of rows) {
    let names = byCollection.get(row.collectionName)
    if (!names) {
      names = new Set<string>()
      byCollection.set(row.collectionName, names)
    }
    names.add(row.filename)
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
