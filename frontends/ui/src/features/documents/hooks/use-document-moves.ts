'use client'

import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileItem, FolderItem } from '../file-types'

/**
 * Re-filing a document: the menu's „Verschieben" lands here, and so does a card
 * dragged onto a folder.
 *
 * Both go through the one `PATCH /api/documents/{id}/folder` — the gesture adds
 * no capability, which is why it is not a second code path that could disagree
 * with the menu about what a move is. The route resolves the shelf from the
 * document, so a project's file and an Archiv file use the same one.
 *
 * The corpus is updated from the answer rather than refetched. The consequence
 * worth noticing: inside a folder, moving a document out makes the row leave the
 * listing under the cursor. That is correct (the folder is the filter), and the
 * toast names where it went, so the disappearance is explained, not observed.
 */
export function useDocumentMoves(
  files: readonly FileItem[],
  setFiles: Dispatch<SetStateAction<FileItem[]>>,
  folders: readonly FolderItem[]
) {
  const t = useTranslations('files')

  const moved = useCallback(
    (fileId: string, folderId: string | null) =>
      setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, folderId } : f))),
    [setFiles]
  )

  /** Optimistic: the card visibly leaves the level under the finger, so waiting for a round trip would make a good move look broken. */
  const dropInFolder = useCallback(
    async (documentId: string, folderId: string | null) => {
      const file = files.find((candidate) => candidate.id === documentId)
      if (!file || (file.folderId ?? null) === folderId) return
      const previousFolderId = file.folderId ?? null
      const folderName = folderId
        ? (folders.find((folder) => folder.id === folderId)?.name ?? '')
        : t('folders.allFiles')

      moved(documentId, folderId)
      try {
        const response = await fetch(`/api/documents/${documentId}/folder`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId }),
        })
        if (!response.ok) throw new Error(`Move failed (${response.status})`, { cause: response.status })
        toast.success(t('actions.moved', { name: documentDisplayName(file), folder: folderName }))
      } catch (error) {
        moved(documentId, previousFolderId)
        // 409: an IFC model bound for a restricted folder (ADR-0078). Retrying
        // cannot help, so say why.
        toast.error(
          error instanceof Error && error.cause === 409 ? t('folders.access.ifcRefused') : t('actions.moveError')
        )
      }
    },
    [files, folders, moved, t]
  )

  return { moved, dropInFolder }
}
