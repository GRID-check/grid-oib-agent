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
import { startBrowserDownload } from '@/lib/browser-download'
import { documentDisplayName, type NamedDocument } from '@/lib/documents/display-name'

/** Which corpus the document belongs to — and so which words and which route. */
export type DocumentScope = 'files' | 'archiv'

/** The least a surface has to know about a document to act on it. */
export interface ActionableDocument extends NamedDocument {
  id: string
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
  /** The document is gone. Surfaces drop it from their list and close anything
   * that was showing it. */
  onDeleted?: (documentId: string) => void
}

export interface DocumentActions {
  /** The name to show right now (the rename if there is one, else the file's). */
  name: string
  /** True once the document carries a rename — gates "restore original name". */
  isRenamed: boolean
  isRenaming: boolean
  isDeleting: boolean
  isDownloading: boolean
  /** The last download attempt failed; cleared when a new one starts. */
  downloadFailed: boolean
  /** `null` restores the file's own name. Resolves false when nothing changed. */
  rename: (displayName: string | null) => Promise<boolean>
  remove: () => Promise<boolean>
  download: () => Promise<void>
}

export function useDocumentActions({
  document,
  scope,
  onRenamed,
  onDeleted,
}: UseDocumentActionsOptions): DocumentActions {
  const t = useTranslations(scope)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
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
      const url = scope === 'archiv' ? `/api/archiv/documents/${document.id}` : `/api/documents/${document.id}`
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
   * The download route answers with JSON (`{ downloadUrl }`), not with bytes —
   * so this fetches the link and then starts a browser download. Do not
   * `location.assign` the presigned URL: if the object store ignores
   * `Content-Disposition` the whole SPA is replaced by the file (#434).
   */
  const download = useCallback(async (): Promise<void> => {
    setDownloadFailed(false)
    setIsDownloading(true)
    try {
      const res = await fetch(`/api/documents/${document.id}/download`)
      const data = res.ok ? await res.json() : null
      if (typeof data?.downloadUrl === 'string' && data.downloadUrl !== '') {
        startBrowserDownload(
          data.downloadUrl,
          typeof data.filename === 'string' && data.filename !== '' ? data.filename : name,
        )
      } else setDownloadFailed(true)
    } catch {
      setDownloadFailed(true)
    } finally {
      setIsDownloading(false)
    }
  }, [document.id, name])

  return {
    name,
    isRenamed,
    isRenaming,
    isDeleting,
    isDownloading,
    downloadFailed,
    rename,
    remove,
    download,
  }
}
