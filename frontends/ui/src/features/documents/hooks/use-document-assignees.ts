'use client'

import { useEffect, useState } from 'react'
import type { FileAssignee } from '../components/project-file-workspace'

/**
 * Who is on the hook for a document. Same list the Files preview reads —
 * assignment is on the document, not on the IFC model row.
 */
export function useDocumentAssignees(documentId: string | null, enabled: boolean) {
  const [assignees, setAssignees] = useState<FileAssignee[]>([])

  useEffect(() => {
    if (!documentId || !enabled) {
      setAssignees([])
      return
    }
    let cancelled = false
    void fetch(`/api/assignments/document/${encodeURIComponent(documentId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { assignees?: FileAssignee[] } | null) => {
        if (cancelled) return
        setAssignees(body?.assignees ?? [])
      })
      .catch(() => {
        if (!cancelled) setAssignees([])
      })
    return () => {
      cancelled = true
    }
  }, [documentId, enabled])

  return [assignees, setAssignees] as const
}
