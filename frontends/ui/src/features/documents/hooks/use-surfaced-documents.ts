'use client'

import { useEffect, useState } from 'react'
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
}

/** Module-wide cache: one index fetch per project per page lifetime. */
const indexCache = new Map<string, Promise<SurfacedIndex>>()

/** Test hook — clears the module cache between specs. */
export const resetSurfacedDocumentsCache = (): void => {
  indexCache.clear()
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

function loadSurfacedIndex(projectId: string | null): Promise<SurfacedIndex> {
  const key = projectId ?? '__no-project__'
  const existing = indexCache.get(key)
  if (existing) return existing

  const promise = (async (): Promise<SurfacedIndex> => {
    const [projektResult, bueroResult] = await Promise.allSettled([
      projectId
        ? fetch(`/api/documents?projectId=${encodeURIComponent(projectId)}`).then((r) => (r.ok ? r.json() : null))
        : Promise.resolve(null),
      // Büroarchiv is org-scoped (no projectId) and feature-gated — a 403/blocked
      // fetch simply yields no Archiv resolutions (fail-open).
      fetch('/api/archiv/documents').then((r) => (r.ok ? r.json() : null)),
    ])
    const projekt = indexByFilename(projektResult.status === 'fulfilled' ? projektResult.value?.documents : null)
    const buero = indexByFilename(bueroResult.status === 'fulfilled' ? bueroResult.value?.documents : null)
    return { projekt, buero }
  })()

  indexCache.set(key, promise)
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
 * Known limit: the document lists are bounded (`DOCUMENT_LIST_LIMIT`, 500/corpus),
 * so in a corpus larger than that a legitimately-surfaced file beyond the window
 * resolves as "unavailable". Fine at current sizes; a targeted by-filename
 * resolve endpoint would remove the cap.
 */
export function useSurfacedDocuments(
  documents: SurfacedDocument[],
  projectId: string | null
): { resolved: ResolvedSurfacedDocument[]; isLoading: boolean } {
  const [index, setIndex] = useState<SurfacedIndex | null>(null)

  useEffect(() => {
    let cancelled = false
    loadSurfacedIndex(projectId)
      .then((loaded) => {
        if (!cancelled) setIndex(loaded)
      })
      .catch(() => {
        if (!cancelled) setIndex({ projekt: new Map(), buero: new Map() })
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const resolved: ResolvedSurfacedDocument[] = documents.map((surfaced, i) => {
    const key = `${surfaced.file_name}-${i}`
    if (!index) return { key, surfaced, file: null, docSource: null }

    // When the backend tagged the corpus, resolve ONLY within it — a file with
    // the same name in the other corpus is a DIFFERENT document, so never cross
    // over (that would open the wrong file). Cross-corpus resolution is allowed
    // only when the tool gave no source, purely as a best-effort last resort.
    if (surfaced.source === 'projekt' || surfaced.source === 'buero') {
      const map = surfaced.source === 'buero' ? index.buero : index.projekt
      const hit = map.get(surfaced.file_name)
      return hit ? { key, surfaced, file: hit, docSource: surfaced.source } : { key, surfaced, file: null, docSource: null }
    }

    const inProjekt = index.projekt.get(surfaced.file_name)
    if (inProjekt) return { key, surfaced, file: inProjekt, docSource: 'projekt' }
    const inBuero = index.buero.get(surfaced.file_name)
    if (inBuero) return { key, surfaced, file: inBuero, docSource: 'buero' }
    return { key, surfaced, file: null, docSource: null }
  })

  return { resolved, isLoading: index === null }
}
