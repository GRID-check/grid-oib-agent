'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileItem } from '../components/project-file-workspace'
import { onDocumentsChanged } from '@/lib/documents/document-changes'

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

/**
 * Which corpus a filename was resolved in.
 *
 * `session` is a shelf the backend's `surface_documents` tool cannot name, so a
 * SURFACED document never resolves to one; it exists for the caller that asks
 * the question the other way round — {@link storedFileIndex}, which is how an
 * answer's prose reaches a file the reader attached to this very conversation.
 */
export type DocumentCorpus = 'projekt' | 'buero' | 'session'

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
   * filename → row, THIS conversation's private attachments (ADR-0047's
   * `session` shelf). Empty unless the caller named a conversation.
   *
   * Added for the answer's file references: a reader drops a PDF into the
   * composer, asks about it, and the answer names it back — and until this map
   * existed that filename resolved to nothing at all, because the only two
   * corpora here were the ones the backend's `surface_documents` tool can tag.
   * Consulted last, and only for a surfaced document that names no source, so
   * no tagged resolution changes.
   */
  session: Map<string, FileItem>
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

/**
 * The conversation is part of the key, not just of the fetch: two chats in one
 * project have different private attachments, and one cached index would hand
 * a thread the other thread's files.
 */
const cacheKey = (projectId: string | null, conversationId: string | null): string =>
  `${projectId ?? '__no-project__'}|${conversationId ?? '__no-conversation__'}`

/** Test hook — clears the module cache between specs. */
export const resetSurfacedDocumentsCache = (): void => {
  indexCache.clear()
}

// Same reason as the citation index: a card that names a file uploaded during
// the conversation must resolve to it, not to nothing.
onDocumentsChanged(resetSurfacedDocumentsCache)

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

/**
 * Keep the most-recently-created row when a filename repeats (re-uploads).
 *
 * Keyed on the LOWERCASED name, and read back through {@link corpusLookup}.
 * A name is a name: `Grundriss.PDF` and `grundriss.pdf` in one corpus are a
 * re-upload, not two documents, and the exact-match index made an answer that
 * spelled a filename in a different case resolve to nothing — a dead tile on a
 * card, and (once answers began naming their files in prose) plain text where a
 * chip belonged. Two rows that differ only in case collapse onto the newer one,
 * which is what the same-name rule above already does.
 */
function indexByFilename(rows: unknown): Map<string, FileItem> {
  const map = new Map<string, FileItem>()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const file = row as FileItem
    if (typeof file.id !== 'string' || typeof file.filename !== 'string') continue
    const key = file.filename.toLowerCase()
    const existing = map.get(key)
    if (!existing || new Date(file.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      map.set(key, file)
    }
  }
  return map
}

/** Read a corpus map built by {@link indexByFilename}. */
const corpusLookup = (corpus: Map<string, FileItem>, fileName: string): FileItem | undefined =>
  corpus.get(fileName.trim().toLowerCase())

export async function resolveStoredDocument(
  projectId: string | null,
  fileName: string,
  source: 'projekt' | 'buero',
): Promise<FileItem | null> {
  const index = await loadSurfacedIndex(projectId, null)
  return corpusLookup(source === 'buero' ? index.buero : index.projekt, fileName) ?? null
}

/** One openable file, with the corpus it was found in. */
export interface StoredFile {
  file: FileItem
  corpus: DocumentCorpus
}

/**
 * Every file the reader can open here, keyed by lowercased filename.
 *
 * The same index, asked the question the other way round: not "where is this
 * named file?" but "which of my files could this text be naming?" — which is
 * what an answer's prose references need, since the set of things that can BE a
 * file reference is exactly the set of files the reader has.
 *
 * Precedence on a shared name is the shelf's own: the project's copy is the one
 * everybody on the project means, the Büroarchiv's the office-wide one, and a
 * private attachment is reached only when neither holds the name. Same order
 * the surfaced fallback above uses, for the same reason.
 */
export async function storedFileIndex(
  projectId: string | null,
  conversationId: string | null
): Promise<Map<string, StoredFile>> {
  const index = await loadSurfacedIndex(projectId, conversationId)
  const byName = new Map<string, StoredFile>()
  const corpora: ReadonlyArray<readonly [DocumentCorpus, Map<string, FileItem>]> = [
    ['session', index.session],
    ['buero', index.buero],
    ['projekt', index.projekt],
  ]
  // Written least-specific first, so the project's copy overwrites the rest.
  for (const [corpus, rows] of corpora) {
    for (const [key, file] of rows) byName.set(key, { file, corpus })
  }
  return byName
}

function loadSurfacedIndex(
  projectId: string | null,
  conversationId: string | null
): Promise<SurfacedIndex> {
  const key = cacheKey(projectId, conversationId)
  const existing = indexCache.get(key)
  if (existing) return existing

  const promise = (async (): Promise<SurfacedIndex> => {
    const [projektRes, bueroRes, sessionRes] = await Promise.all([
      // The project list is the primary corpus — any non-ok is a genuine error.
      projectId
        ? fetchCorpus(`/api/documents?projectId=${encodeURIComponent(projectId)}`, [])
        : Promise.resolve({ rows: null, failed: false }),
      // Büroarchiv is org-scoped (no projectId) and feature-gated — a 403 (or a
      // 404) is fail-open (no Archiv resolutions), NOT an error.
      fetchCorpus('/api/archiv/documents', [403, 404]),
      // This conversation's private attachments. A caller that names no
      // conversation gets an empty session corpus and no extra request.
      conversationId
        ? fetchCorpus(
            `/api/session/documents?conversationId=${encodeURIComponent(conversationId)}`,
            [403, 404]
          )
        : Promise.resolve({ rows: null, failed: false }),
    ])
    return {
      projekt: indexByFilename(projektRes.rows),
      buero: indexByFilename(bueroRes.rows),
      session: indexByFilename(sessionRes.rows),
      error: projektRes.failed || bueroRes.failed || sessionRes.failed,
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
  projectId: string | null,
  /**
   * The conversation whose private attachments join the index. Omit it and the
   * `session` corpus is empty and unfetched — which is what every card surface
   * wants, since `surface_documents` cannot name that shelf.
   */
  conversationId: string | null = null
): { resolved: ResolvedSurfacedDocument[]; isLoading: boolean; error: boolean; retry: () => void } {
  const [index, setIndex] = useState<SurfacedIndex | null>(null)
  // Bumped by `retry` to re-run the load effect after evicting the cache.
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    // Back to the loading state on (re)load so callers show a skeleton, not the
    // previous (possibly dead) resolution.
    setIndex(null)
    loadSurfacedIndex(projectId, conversationId)
      .then((loaded) => {
        if (!cancelled) setIndex(loaded)
      })
      .catch(() => {
        if (!cancelled) {
          setIndex({ projekt: new Map(), buero: new Map(), session: new Map(), error: true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectId, conversationId, reloadTick])

  const retry = useCallback(() => {
    indexCache.delete(cacheKey(projectId, conversationId))
    setReloadTick((t) => t + 1)
  }, [projectId, conversationId])

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
          const hit = corpusLookup(map, surfaced.file_name)
          return hit
            ? { key, surfaced, file: hit, docSource: surfaced.source }
            : { key, surfaced, file: null, docSource: null }
        }

        const inProjekt = corpusLookup(index.projekt, surfaced.file_name)
        if (inProjekt) return { key, surfaced, file: inProjekt, docSource: 'projekt' }
        const inBuero = corpusLookup(index.buero, surfaced.file_name)
        if (inBuero) return { key, surfaced, file: inBuero, docSource: 'buero' }
        return { key, surfaced, file: null, docSource: null }
      }),
    [documents, index]
  )

  return { resolved, isLoading: index === null, error: index?.error ?? false, retry }
}
