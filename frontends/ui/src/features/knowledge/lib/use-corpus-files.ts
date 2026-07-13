'use client'

/**
 * Session-cached list of base-corpus files (name + origin) for citation →
 * PDF resolution. One fetch per browser session, shared by every card; a
 * failed fetch resolves to an empty list so citations quietly keep their
 * external-link fallback.
 */

import { useEffect, useState } from 'react'
import type { CorpusFileCandidate } from './resolve-corpus-file'

let cache: Promise<CorpusFileCandidate[]> | null = null

function fetchCorpusFiles(): Promise<CorpusFileCandidate[]> {
  cache ??= fetch('/api/knowledge-base')
    .then((r) => (r.ok ? r.json() : { files: [] }))
    .then((data) =>
      (Array.isArray(data.files) ? data.files : []).map((f: { fileName?: string; origin?: string }) => ({
        fileName: String(f.fileName ?? ''),
        origin: String(f.origin ?? 'index_only'),
      })),
    )
    .catch(() => [])
  return cache
}

/** Test hook. */
export function resetCorpusFilesCache(): void {
  cache = null
}

export function useCorpusFiles(): CorpusFileCandidate[] {
  const [files, setFiles] = useState<CorpusFileCandidate[]>([])

  useEffect(() => {
    let cancelled = false
    void fetchCorpusFiles().then((result) => {
      if (!cancelled) setFiles(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return files
}
