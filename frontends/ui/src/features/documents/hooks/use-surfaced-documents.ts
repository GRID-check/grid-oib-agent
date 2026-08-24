'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileItem } from '../components/project-file-workspace'

/**
 * One document surfaced by the backend `surface_documents` tool: a real indexed
 * file name plus the match evidence (best snippet, page, 0..1 score) and the
 * coarse corpus it came from. Mirrors the `document_grid` card's document shape.
 */
export interface SurfacedDocument {
  file_name: string
  summary?: string | null
  snippet?: string | null
  page?: number | null
  score?: number | null
  source?: 'projekt' | 'buero' | null
}

/** A surfaced document resolved (or not) to its live document row. */
export interface ResolvedSurfacedDocument {
  /** Stable render key. */
  key: string
  surfaced: SurfacedDocument
  /** The live document row (id, status, thumbnail…) or `null` when unresolvable. */
  file: FileItem | null
  /** Which corpus the resolved row came from (drives the provenance badge). */
  docSource: 'projekt' | 'buero' | null
}

interface SurfacedIndex {
  /** filename → row, project corpus. */
  projekt: Map<string, FileItem>
  /** filename → row, Büroarchiv. */
  buero: Map<string, FileItem>
  /**
   * A GENUINE fetch failure occurred (network / 5xx) so resolutions may be
   * incomplete — distinct from a legitimately-empty corpus or a fail-open
   * feature gate (Archiv 403). Drives the retry affordance instead of a wall of
   * dead "unresolved" tiles.
   */
  error: boolean
}

/** Module-wide cache: one index fetch per project per page lifetime. */
const indexCache = new Map<string, Promise<SurfacedIndex>>()

const cacheKey = (projectId: string | null): string => projectId ?? '__no-project__'

/** Test hook — clears the module cache between specs. */
export const resetSurfacedDocumentsCache = (): void => {
  indexCache.clear()
}

/**
 * Fetch one corpus' document list. `softStatuses` are fail-open (e.g. Archiv 403
 * feature gate) — no rows, but NOT an error. Any other non-ok status or a
 * network reject IS a genuine error the caller surfaces as retryable.
 */
async function fetchCorpus(
  url: string,
  softStatuses: number[]
): Promise<{ rows: unknown; failed: boolean }> {
  try {
    const r = await fetch(url)
    if (r.ok) {
      const body = await r.json().catch(() => null)
      return { rows: (body as { documents?: unknown } | null)?.documents ?? null, failed: false }
    }
    return { rows: null, failed: !softStatuses.includes(r.status) }
  } catch {
    return { rows: null, failed: true }
  }
}

/** Keep the most-recently-created row when a filename repeats (re-uploads). */
function indexByFilename(rows: unknown): Map<string, FileItem> {
  const map = new Map<string, FileItem>()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const file = row as FileItem
    if (typeof file.id !== 'string' || typeof file.filename !== 'string') continue
    const existing = map.get(file.filename)
    if (!existing || new Date(file.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      map.set(file.filename, file)
    }
  }
  return map
}

export async function resolveStoredDocument(
  projectId: string | null,
  fileName: string,
  source: 'projekt' | 'buero',
): Promise<FileItem | null> {
  const index = await loadSurfacedIndex(projectId)
  return (source === 'buero' ? index.buero : index.projekt).get(fileName) ?? null
}

function loadSurfacedIndex(projectId: string | null): Promise<SurfacedIndex> {
  const key = cacheKey(projectId)
  const existing = indexCache.get(key)
  if (existing) return existing

  const promise = (async (): Promise<SurfacedIndex> => {
    const [projektRes, bueroRes] = await Promise.all([
      // The project list is the primary corpus — any non-ok is a genuine error.
      projectId
        ? fetchCorpus(`/api/documents?projectId=${encodeURIComponent(projectId)}`, [])
        : Promise.resolve({ rows: null, failed: false }),
      // Büroarchiv is org-scoped (no projectId) and feature-gated — a 403 (or a
      // 404) is fail-open (no Archiv resolutions), NOT an error.
      fetchCorpus('/api/archiv/documents', [403, 404]),
    ])
    return {
      projekt: indexByFilename(projektRes.rows),
      buero: indexByFilename(bueroRes.rows),
      error: projektRes.failed || bueroRes.failed,
    }
  })()

  indexCache.set(key, promise)
  // Don't cache a failed resolution — evict so a retry (or later mount) refetches.
  promise
    .then((idx) => {
      if (idx.error) indexCache.delete(key)
    })
    .catch(() => indexCache.delete(key))
  return promise
}

/**
 * Resolve the `document_grid` card's surfaced documents to their live rows.
 *
 * Fetches the project's document list and the org Büroarchiv list once (cached),
 * then joins each surfaced file name to its row within the corpus the backend
 * tagged (`source`) — never crossing corpora when the source is known, so a
 * same-named file in the other store can't be opened by mistake. Fail-open: a
 * failed fetch yields unresolved entries (rendered as lean, non-clickable
 * cards), never a crash. Order is preserved (best match first).
 *
 * TODO(backend): the document lists are bounded (`DOCUMENT_LIST_LIMIT`, 500 per
 * corpus), so in a corpus larger than that a legitimately-surfaced file beyond
 * the window resolves as unresolved. Fine at current sizes; a targeted
 * by-filename resolve endpoint (e.g. `GET /api/documents/resolve?name=…`) would
 * remove the cap. Until then the frontend degrades honestly — an unresolved file
 * renders an actionable "open in the archive/files" card, never a dead tile.
 */
export function useSurfacedDocuments(
  documents: SurfacedDocument[],
  projectId: string | null
): { resolved: ResolvedSurfacedDocument[]; isLoading: boolean; error: boolean; retry: () => void } {
  const [index, setIndex] = useState<SurfacedIndex | null>(null)
  // Bumped by `retry` to re-run the load effect after evicting the cache.
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    // Back to the loading state on (re)load so callers show a skeleton, not the
    // previous (possibly dead) resolution.
    setIndex(null)
    loadSurfacedIndex(projectId)
      .then((loaded) => {
        if (!cancelled) setIndex(loaded)
      })
      .catch(() => {
        if (!cancelled) setIndex({ projekt: new Map(), buero: new Map(), error: true })
      })
    return () => {
      cancelled = true
    }
  }, [projectId, reloadTick])

  const retry = useCallback(() => {
    indexCache.delete(cacheKey(projectId))
    setReloadTick((t) => t + 1)
  }, [projectId])

  // Memoized so the resolved rows (and the file objects the grid remaps from
  // them) keep a stable identity across renders while nothing changed — no
  // thumbnail-fetch thrash downstream.
  const resolved = useMemo<ResolvedSurfacedDocument[]>(
    () =>
      documents.map((surfaced, i) => {
        const key = `${surfaced.file_name}-${i}`
        if (!index) return { key, surfaced, file: null, docSource: null }

        // When the backend tagged the corpus, resolve ONLY within it — a file
        // with the same name in the other corpus is a DIFFERENT document, so
        // never cross over (that would open the wrong file). Cross-corpus
        // resolution is allowed only when the tool gave no source, purely as a
        // best-effort last resort.
        if (surfaced.source === 'projekt' || surfaced.source === 'buero') {
          const map = surfaced.source === 'buero' ? index.buero : index.projekt
          const hit = map.get(surfaced.file_name)
          return hit
            ? { key, surfaced, file: hit, docSource: surfaced.source }
            : { key, surfaced, file: null, docSource: null }
        }

        const inProjekt = index.projekt.get(surfaced.file_name)
        if (inProjekt) return { key, surfaced, file: inProjekt, docSource: 'projekt' }
        const inBuero = index.buero.get(surfaced.file_name)
        if (inBuero) return { key, surfaced, file: inBuero, docSource: 'buero' }
        return { key, surfaced, file: null, docSource: null }
      }),
    [documents, index]
  )

  return { resolved, isLoading: index === null, error: index?.error ?? false, retry }
}
