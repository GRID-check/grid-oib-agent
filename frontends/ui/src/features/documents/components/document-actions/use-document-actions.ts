'use client'

/**
 * What can be DONE to a document, in one place.
 *
 * Every surface that shows a document — the file grid's preview, the explorer
 * list, the Büroarchiv, the model viewport — needs the same three operations,
 * and before this each of them either re-implemented one or simply did not
 * offer it. The viewport had none at all: a model could be uploaded and looked
 * at, and then only deleted by finding it again in a different view.
 *
 * The hook owns the WORK (request, pending flag, toast, the callback that tells
 * the surface what changed); the components beside it own the shapes. That
 * split is what lets the viewport render its operations as a glass pill and the
 * preview render them as a menu item without either of them owning a `fetch`.
 *
 * ## Scope
 *
 * `files` and `archiv` differ in exactly one place — the DELETE endpoint, which
 * is org-gated for the Archiv — and in which namespace holds the words. Rename
 * goes to the same scope-aware route for both, because the service resolves the
 * permission from the document row rather than from the URL.
 */

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { startDocumentDownload } from '@/lib/documents/download'
import { documentDisplayName, type NamedDocument } from '@/lib/documents/display-name'

/** Which corpus the document belongs to — and so which words and which route. */
export type DocumentScope = 'files' | 'archiv'

/** The least a surface has to know about a document to act on it. */
export interface ActionableDocument extends NamedDocument {
  id: string
  /** Only read to decide whether a re-ingest is worth offering. */
  status?: string | null
  /** Where it is filed now, so a move can mark the current folder. */
  folderId?: string | null
}

export interface UseDocumentActionsOptions {
  document: ActionableDocument
  scope: DocumentScope
  /**
   * The rename landed. `displayName` is `null` when the document was restored
   * to its file name — surfaces mirror it into their own state so the new name
   * is on screen before any refetch.
   */
  onRenamed?: (documentId: string, displayName: string | null) => void
  /** The document was sent back through ingestion; carries the new status. */
  onReingested?: (documentId: string, status: string) => void
  /** The document is gone. Surfaces drop it from their list and close anything
   * that was showing it. */
  onDeleted?: (documentId: string) => void
  /** The document was re-filed; `null` means the project root. */
  onMoved?: (documentId: string, folderId: string | null) => void
}

export interface DocumentActions {
  /** The name to show right now (the rename if there is one, else the file's). */
  name: string
  /** True once the document carries a rename — gates "restore original name". */
  isRenamed: boolean
  isRenaming: boolean
  isDeleting: boolean
  isDownloading: boolean
  isReingesting: boolean
  /** The last download attempt failed; cleared when a new one starts. */
  downloadFailed: boolean
  /** `null` restores the file's own name. Resolves false when nothing changed. */
  rename: (displayName: string | null) => Promise<boolean>
  remove: () => Promise<boolean>
  download: () => Promise<void>
  /** Send a failed document back through ingestion; resolves the new status. */
  reingest: () => Promise<string | null>
  isMoving: boolean
  /** Re-file into another folder; `null` is the project root. */
  move: (folderId: string | null, folderName: string) => Promise<boolean>
}

export function useDocumentActions({
  document,
  scope,
  onRenamed,
  onDeleted,
  onReingested,
  onMoved,
}: UseDocumentActionsOptions): DocumentActions {
  const t = useTranslations(scope)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isReingesting, setIsReingesting] = useState(false)
  const [isMoving, setIsMoving] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)

  const name = documentDisplayName(document)
  const isRenamed = name !== document.filename

  const rename = useCallback(
    async (displayName: string | null): Promise<boolean> => {
      setIsRenaming(true)
      try {
        const res = await fetch(`/api/documents/${document.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName }),
        })
        if (!res.ok) throw new Error(`Rename failed (${res.status})`)
        // The server decides the stored value: it trims, and it stores `null`
        // for a rename back to the file's own name. Reading it back rather than
        // echoing what was sent keeps the surface's state equal to the row's.
        const body: unknown = await res.json().catch(() => null)
        const stored =
          body !== null && typeof body === 'object' && 'displayName' in body
            ? ((body as { displayName: string | null }).displayName ?? null)
            : displayName
        onRenamed?.(document.id, stored)
        toast.success(
          stored === null
            ? t('rename.restored', { name: document.filename })
            : t('rename.success', { name: stored })
        )
        return true
      } catch {
        toast.error(t('rename.error'))
        return false
      } finally {
        setIsRenaming(false)
      }
    },
    [document.id, document.filename, onRenamed, t]
  )

  const remove = useCallback(async (): Promise<boolean> => {
    setIsDeleting(true)
    try {
      const url =
        scope === 'archiv'
          ? `/api/archiv/documents/${document.id}`
          : `/api/documents/${document.id}`
      const res = await fetch(url, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`)
      toast.success(t('delete.success', { name }))
      onDeleted?.(document.id)
      return true
    } catch {
      toast.error(t('delete.error'))
      return false
    } finally {
      setIsDeleting(false)
    }
  }, [document.id, name, onDeleted, scope, t])

  /**
   * Shared with the citation surface — see `lib/documents/download.ts`, which
   * also carries the reason the presigned URL is never navigated to (#434).
   * This side owns only how a failure READS here: an inline line, not a toast.
   */
  const download = useCallback(async (): Promise<void> => {
    setDownloadFailed(false)
    setIsDownloading(true)
    try {
      if (!(await startDocumentDownload(document.id, name))) setDownloadFailed(true)
    } finally {
      setIsDownloading(false)
    }
  }, [document.id, name])

  /**
   * Send a failed document back through ingestion.
   *
   * Here, with rename/delete/download, rather than inline in the preview pane
   * where it started: a failed document's card SAYS why it failed and, until
   * this moved, could do nothing about it — the only retry in the product was
   * two clicks inside a viewer the reader had no reason to open, since the card
   * had already told them the bad news. An operation on a document belongs with
   * the operations on a document, so every surface that shows the failure can
   * offer the way out of it.
   */
  const reingest = useCallback(async (): Promise<string | null> => {
    setIsReingesting(true)
    try {
      const res = await fetch(`/api/documents/${document.id}/reingest`, { method: 'POST' })
      if (!res.ok) throw new Error(`Reingest failed (${res.status})`)
      const data = await res.json().catch(() => ({}))
      const status = typeof data?.status === 'string' ? data.status : 'pending'
      onReingested?.(document.id, status)
      return status
    } catch {
      toast.error(t('actions.reingestError'))
      return null
    } finally {
      setIsReingesting(false)
    }
  }, [document.id, onReingested, t])

  /**
   * Re-file the document. `folderName` is only for the words — the toast has to
   * say WHERE it went, or "Moved" is a claim the reader cannot check without
   * going to look.
   */
  const move = useCallback(
    async (folderId: string | null, folderName: string): Promise<boolean> => {
      setIsMoving(true)
      try {
        const res = await fetch(`/api/documents/${document.id}/folder`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId }),
        })
        if (!res.ok) throw new Error(`Move failed (${res.status})`)
        onMoved?.(document.id, folderId)
        toast.success(t('actions.moved', { name, folder: folderName }))
        return true
      } catch {
        toast.error(t('actions.moveError'))
        return false
      } finally {
        setIsMoving(false)
      }
    },
    [document.id, name, onMoved, t]
  )

  return {
    name,
    isRenamed,
    isRenaming,
    isDeleting,
    isDownloading,
    isReingesting,
    isMoving,
    downloadFailed,
    rename,
    remove,
    download,
    reingest,
    move,
  }
}
