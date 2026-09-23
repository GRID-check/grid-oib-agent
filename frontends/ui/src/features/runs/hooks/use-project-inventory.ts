'use client'

/**
 * What a run can read, as the picker lists it: the project's documents and
 * the org's Archiv, each as a `PlanDocument` (the name the run is told, the
 * title it is shown under, the shelf it sits on) beside the file row a reader
 * opens it from.
 *
 * Read lazily, through the two listing routes the Files and Archiv pages
 * already use, and only while a dialog that needs it is open — the thread
 * must not fetch a project's whole listing for every run block it renders.
 * Fail-open per shelf: an Archiv that is gated (403) simply lists nothing.
 */

import { useEffect, useState } from 'react'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import { toFileItem, type DocumentWireRow } from '@/features/documents/lib/file-item'
import type { PlanDocument } from '@/lib/runs/plan-documents'

export interface InventoryDocument extends PlanDocument {
  file: FileItem
  source: 'projekt' | 'buero'
}

const listing = async (url: string): Promise<DocumentWireRow[]> => {
  try {
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) return []
    const body = (await response.json()) as { documents?: DocumentWireRow[] }
    return Array.isArray(body.documents) ? body.documents : []
  } catch {
    return []
  }
}

const toInventory = (rows: DocumentWireRow[], source: InventoryDocument['source']): InventoryDocument[] =>
  rows.map((row) => {
    const file = toFileItem(row)
    const title = file.displayName?.trim()
    return {
      name: file.filename,
      ...(title && title !== file.filename ? { title } : {}),
      shelf: source === 'buero' ? 'archiv' : 'project',
      file,
      source,
    }
  })

export function useProjectInventory(projectId: string | null, enabled: boolean): {
  documents: InventoryDocument[] | null
  loading: boolean
} {
  // Keyed by the project it was read for: a block reused under another
  // project must not list the previous project's files as this one's.
  const [loaded, setLoaded] = useState<{ projectId: string; documents: InventoryDocument[] } | null>(
    null
  )
  const [loading, setLoading] = useState(false)
  const documents = loaded && loaded.projectId === projectId ? loaded.documents : null

  useEffect(() => {
    if (!enabled || !projectId || documents !== null) return
    let cancelled = false
    setLoading(true)
    void Promise.all([
      listing(`/api/documents?projectId=${encodeURIComponent(projectId)}`),
      listing('/api/archiv/documents'),
    ]).then(([project, archiv]) => {
      if (cancelled) return
      setLoaded({
        projectId,
        documents: [...toInventory(project, 'projekt'), ...toInventory(archiv, 'buero')],
      })
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, projectId, documents])

  return { documents, loading }
}
