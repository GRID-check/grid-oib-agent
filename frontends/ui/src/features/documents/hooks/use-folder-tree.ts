'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useLocale, useTranslations } from '@/i18n'
import { formatCalendarDate } from '@/lib/format'
import type { FileItem, FolderItem } from '../file-types'
import type { FolderAccessLevel } from '../lib/file-shelf'

export interface FolderTreeOptions {
  /** The shelf's folder collection (`/api/projects/{id}/folders`, `/api/archiv/folders`). */
  foldersUrl: string
  /** The tree as the server already read it, for the first paint. */
  initialFolders?: readonly FolderItem[]
  /**
   * What the reader may do at the shelf's root for the first paint (ADR-0088).
   * Absent means `write`; every listing read refreshes it from `rootAccess`.
   * Only a project's listing reports it; the Archiv's root is `write` here and
   * `canManage` decides.
   */
  initialRootAccess?: FolderAccessLevel
  /** What deleting a folder needs to name: how much is inside it. */
  files: readonly FileItem[]
  selectedFolderId: string | null
  onSelectFolder: (id: string | null) => void
  /** Re-read the documents after a change that moved some (a delete re-files them). */
  reloadFiles: (quiet?: boolean) => Promise<unknown>
  /**
   * The shelf's Papierkorb (a project's, ADR-0088). With it, a delete moves the
   * folder there with its contents and the toast links to it; without it (the
   * Archiv), a delete re-files the contents into the parent.
   */
  binHref?: string
}

/**
 * One shelf's folder tree: read it, and the four things a reader does to it.
 *
 * Every sentence is a `files` key. The Archiv has folders now, and a second set
 * of strings for „Ordner löschen" in another namespace would be the first thing
 * to drift.
 *
 * Rename and move re-read the tree rather than patching it: `path` is
 * materialised on every row, so changing one folder rewrites everything beneath
 * it, and guessing that here would be a second implementation of the server's
 * rule.
 */
export function useFolderTree({
  foldersUrl,
  initialFolders,
  initialRootAccess = 'write',
  files,
  selectedFolderId,
  onSelectFolder,
  reloadFiles,
  binHref,
}: FolderTreeOptions) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const router = useRouter()
  const [folders, setFolders] = useState<FolderItem[]>(() => [...(initialFolders ?? [])])
  const [isLoading, setIsLoading] = useState(initialFolders === undefined)
  const [error, setError] = useState(false)
  /** What the reader may do at the root (ADR-0088); each folder carries its own `access`. */
  const [rootAccess, setRootAccess] = useState<FolderAccessLevel>(initialRootAccess)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(false)
    return fetch(foldersUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load folders (${response.status})`)
        return response.json()
      })
      .then((data: { folders?: FolderItem[]; rootAccess?: FolderAccessLevel }) => {
        setFolders(data.folders ?? [])
        setRootAccess(data.rootAccess === 'read' ? 'read' : 'write')
      })
      .catch(() => {
        setFolders([])
        setError(true)
      })
      .finally(() => setIsLoading(false))
  }, [foldersUrl])

  // The seeded first render is already the answer: skip the mount load once.
  const seeded = useRef(initialFolders !== undefined)
  useEffect(() => {
    if (seeded.current) {
      seeded.current = false
      return
    }
    void load()
  }, [load])

  const parentName = useCallback(
    (parentId: string | null) =>
      parentId ? (folders.find((f) => f.id === parentId)?.name ?? '') : t('folders.allFiles'),
    [folders, t]
  )

  const create = useCallback(
    async (name: string, parentId?: string) => {
      const response = await fetch(foldersUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      })
      if (!response.ok) {
        toast.error(t('workspace.createFolderError'))
        return false
      }
      const data = await response.json()
      setFolders((prev) => [...prev, data.folder])
      return true
    },
    [foldersUrl, t]
  )

  const rename = useCallback(
    async (folderId: string, name: string) => {
      const response = await fetch(`${foldersUrl}/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) {
        toast.error(t('workspace.renameFolderError'))
        return false
      }
      const data = await response.json()
      await load()
      setFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, ...data.folder } : f)))
      return true
    },
    [foldersUrl, t, load]
  )

  /**
   * A folder dragged onto another folder — or onto „Alle Dateien", the way back
   * out to the root. Optimistic on the PARENT (the tile moves in the frame the
   * finger let go) and then re-read for the paths. The pane refuses a move into
   * a folder's own subtree before the drop, so the failure this puts back is a
   * network one.
   */
  const move = useCallback(
    async (draggedFolderId: string, parentId: string | null) => {
      const folder = folders.find((candidate) => candidate.id === draggedFolderId)
      if (!folder || (folder.parentId ?? null) === parentId) return
      const previousParentId = folder.parentId ?? null
      const setParent = (next: string | null) =>
        setFolders((prev) => prev.map((f) => (f.id === draggedFolderId ? { ...f, parentId: next } : f)))

      setParent(parentId)
      try {
        const response = await fetch(`${foldersUrl}/${draggedFolderId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentId }),
        })
        if (!response.ok) throw new Error(`Move failed (${response.status})`, { cause: response.status })
        await load()
        toast.success(t('folders.movedFolder', { name: folder.name, parent: parentName(parentId) }))
      } catch (error) {
        setParent(previousParentId)
        // 409: the folder holds an IFC model and the destination is restricted
        // (ADR-0087). Retrying cannot help, so say why.
        toast.error(
          error instanceof Error && error.cause === 409 ? t('folders.access.ifcRefused') : t('folders.moveFolderError')
        )
      }
    },
    [folders, foldersUrl, load, parentName, t]
  )

  /**
   * NAME WHAT HAPPENS TO THE WORK. A folder is a label somebody put on a set of
   * documents, and the one question in this reader's head is "does this delete
   * my files?" — so the confirm answers it, instead of a generic "this cannot
   * be undone" that would be frightening and, on both shelves, false. On a
   * shelf with a Papierkorb the contents go into it with the folder and can be
   * restored; on the Archiv they are re-filed into the parent, with the count
   * and where they will be.
   */
  const remove = useCallback(
    async (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId)
      if (!folder) return false
      const inside = files.filter((f) => f.folderId === folderId).length
      const nested = folders.filter((f) => f.parentId === folderId).length
      const parent = folder.parentId
        ? (folders.find((f) => f.id === folder.parentId)?.name ?? t('folders.allFiles'))
        : t('folders.allFiles')
      const question = binHref
        ? t('workspace.binFolderConfirm', { name: folder.name })
        : inside > 0 || nested > 0
          ? t('workspace.deleteFolderConfirmWithContents', {
              name: folder.name,
              documents: String(inside),
              folders: String(nested),
              parent,
            })
          : t('workspace.deleteFolderConfirm', { name: folder.name })
      if (!window.confirm(question)) return false

      const response = await fetch(`${foldersUrl}/${folderId}`, { method: 'DELETE' })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { details?: { reason?: unknown } } | null
        const reason = typeof body?.details?.reason === 'string' ? body.details.reason : null
        toast.error(
          reason === 'folder-contents-protected'
            ? t('workspace.deleteFolderProtected')
            : response.status === 502
              ? t('workspace.deleteFolderIndexDown')
              : t('workspace.deleteFolderError')
        )
        return false
      }
      const answer = (await response.json().catch(() => ({}))) as { documentsMoved?: number; purgeAfter?: string }
      // The selection cannot stay on a folder that no longer exists — it would
      // filter the grid to nothing and read as an empty shelf.
      if (selectedFolderId === folderId) onSelectFolder(folder.parentId ?? null)
      await Promise.all([load(), reloadFiles(true)])
      if (binHref) {
        toast.success(
          t('workspace.binFolderDone', {
            name: folder.name,
            date: answer.purgeAfter ? formatCalendarDate(answer.purgeAfter, locale) : '—',
          }),
          { action: { label: t('workspace.openBin'), onClick: () => router.push(binHref) } }
        )
        return true
      }
      toast.success(
        answer.documentsMoved
          ? t('workspace.deleteFolderMoved', { count: String(answer.documentsMoved), parent })
          : t('workspace.deleteFolderDone', { name: folder.name })
      )
      return true
    },
    [foldersUrl, binHref, t, locale, router, folders, files, selectedFolderId, onSelectFolder, load, reloadFiles]
  )

  return { folders, rootAccess, isLoading, error, load, create, rename, move, remove }
}
