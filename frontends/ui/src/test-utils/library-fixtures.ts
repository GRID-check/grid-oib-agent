/**
 * A document as the document picker and the plan's Unterlagen see it: one
 * listing row, projected by the same `toLibraryDocument` the live listing uses,
 * so a fixture cannot drift from what a real row turns into.
 */

import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import {
  toLibraryDocument,
  type LibraryDocument,
  type LibraryShelf,
} from '@/features/documents/hooks/use-document-library'

export function libraryDocument(
  filename: string,
  {
    shelf = 'project',
    title,
    folderId = null,
    pageCount = 4,
  }: { shelf?: LibraryShelf; title?: string; folderId?: string | null; pageCount?: number | null } = {}
): LibraryDocument {
  return toLibraryDocument(
    {
      id: `doc-${filename}`,
      filename,
      displayName: title ?? null,
      fileSize: 2048,
      contentType: 'application/pdf',
      status: 'ready',
      folderId,
      createdAt: '2026-09-01T00:00:00Z',
      pageCount,
    },
    shelf
  )
}

export function folder(id: string, name: string, parentId: string | null = null): FolderItem {
  return { id, parentId, name, path: `/${name}` }
}
