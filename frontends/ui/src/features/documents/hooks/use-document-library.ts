'use client'

/**
 * What a document picker can offer: the project's documents and folders, and
 * the organization's Büroarchiv, read through the listing routes the Files and
 * Archiv pages already use.
 *
 * Read lazily, and only while `enabled` — a thread renders many run blocks and
 * must not fetch a project's whole listing for each of them. Read once per
 * mount: a picker that is closed and reopened shows the same listing. Fail-open
 * per source: an Archiv that is gated (403) or a folder listing that fails
 * simply contributes nothing.
 */

import { useEffect, useState } from 'react'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'
import { toFileItem, type DocumentWireRow } from '@/features/documents/lib/file-item'
import { documentDisplayName } from '@/lib/documents/display-name'

/** The shelf a library document sits on, in the knowledge layer's words (ADR-0047). */
export type LibraryShelf = 'project' | 'archiv'

export interface LibraryDocument {
  /** The file name: the identity a run, a plan and the knowledge layer name it by. */
  name: string
  /** The rename, when it differs from the file name. */
  title?: string
  shelf: LibraryShelf
  file: FileItem
}

export interface DocumentLibrary {
  documents: LibraryDocument[] | null
  /** The project's folders; the Archiv has none. */
  folders: FolderItem[]
  loading: boolean
}

async function read<T>(url: string, key: string): Promise<T[]> {
  try {
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) return []
    const body = (await response.json()) as Record<string, unknown>
    const rows = body[key]
    return Array.isArray(rows) ? (rows as T[]) : []
  } catch {
    return []
  }
}

export function toLibraryDocument(row: DocumentWireRow, shelf: LibraryShelf): LibraryDocument {
  const file = toFileItem(row)
  const shown = documentDisplayName(file)
  return { name: file.filename, ...(shown !== file.filename ? { title: shown } : {}), shelf, file }
}

export function useDocumentLibrary(projectId: string | null, enabled: boolean): DocumentLibrary {
  const [documents, setDocuments] = useState<LibraryDocument[] | null>(null)
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !projectId || documents !== null) return
    let cancelled = false
    setLoading(true)
    const project = encodeURIComponent(projectId)
    void Promise.all([
      read<DocumentWireRow>(`/api/documents?projectId=${project}`, 'documents'),
      read<DocumentWireRow>('/api/archiv/documents', 'documents'),
      read<FolderItem>(`/api/projects/${project}/folders`, 'folders'),
    ]).then(([own, archiv, projectFolders]) => {
      if (cancelled) return
      setDocuments([
        ...own.map((row) => toLibraryDocument(row, 'project')),
        ...archiv.map((row) => toLibraryDocument(row, 'archiv')),
      ])
      setFolders(projectFolders)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, projectId, documents])

  return { documents, folders, loading }
}
