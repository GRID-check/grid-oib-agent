'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { FileItem } from '../file-types'
import { refreshedFileFields } from '../lib/file-item'
import type { FileShelf } from '../lib/file-shelf'
import { useFilePreviewStore, type FilePreviewContext } from '../stores/file-preview-store'

export interface PreviewHandlers {
  onRenamed: (fileId: string, displayName: string | null) => void
  onDeleted: (fileId: string) => void
  onReingested: (fileId: string, status: string) => void
  onTagsUpdated: (fileId: string, tags: string[]) => void
  onLifecycleChanged: NonNullable<FilePreviewContext['onLifecycleChanged']>
}

/**
 * Which file is open, and how to open and shut it — whichever way the shelf
 * holds its preview.
 *
 * A project's shell mounts the preview host and a chat can drive the same store,
 * so its preview lives there. The Archiv sheet has no host, so its preview is
 * local to the page. Both answer the same three questions — which id is open,
 * open this, shut it — and everything above this hook (the `?doc=` link, the row
 * highlight, the reconciliation) is written once against them.
 *
 * Both halves are always called: hooks cannot be conditional, and the unused
 * half is one subscription and one `useState`. Only the shelf's own is read.
 */
export function usePreviewChannel(
  shelf: FileShelf,
  files: readonly FileItem[],
  handlers: PreviewHandlers
) {
  const storeFileId = useFilePreviewStore((state) => state.file?.id ?? null)
  const [dialogId, setDialogId] = useState<string | null>(null)
  const viaStore = shelf.preview.kind === 'store'
  // A dialog's file is derived from the list, so a document deleted behind it
  // closes it — and `?doc=` follows, because the id read here goes null.
  const dialogFile = viaStore ? null : (files.find((f) => f.id === dialogId) ?? null)
  const openId = viaStore ? storeFileId : (dialogFile?.id ?? null)
  const projectName = shelf.preview.kind === 'store' ? shelf.preview.projectName : undefined

  const open = useCallback(
    (file: FileItem) => {
      if (!viaStore) {
        setDialogId(file.id)
        return
      }
      useFilePreviewStore.getState().open(file, 'modal', {
        projectId: shelf.projectId ?? undefined,
        projectName,
        scope: shelf.documentScope,
        canCollaborate: shelf.canCollaborate,
        showMetadataPanel: shelf.showMetadataPanel,
        showModels: shelf.showModels,
        lifecyclePermissions: shelf.lifecyclePermissions,
        viewerUserId: shelf.currentUserId,
        ...handlers,
      })
    },
    [viaStore, shelf, projectName, handlers]
  )

  const close = useCallback(() => {
    if (viaStore) useFilePreviewStore.getState().close()
    else setDialogId(null)
  }, [viaStore])

  // The open modal is a snapshot the store took when it was opened, and the
  // listing is the fresher read of the same row: without this the grid behind
  // the modal said "Bereit" while the modal kept "Wird verarbeitet…" until it
  // was closed and reopened. A dialog derives its file from the list instead.
  useEffect(() => {
    if (!viaStore) return
    const store = useFilePreviewStore.getState()
    const held = store.file
    const fresh = held && files.find((f) => f.id === held.id)
    if (!held || !fresh) return
    const patch = refreshedFileFields(held, fresh)
    if (patch) store.patchFile(patch)
  }, [viaStore, files])

  return { openId, open, close, dialogFile }
}

/**
 * Keep `?doc=` and the open preview saying the same thing, in both directions.
 *
 * This was two effects pulling one way each, and the transition neither owned
 * was the one the change exists for: pressing Back dropped the parameter and
 * left the file open. One effect, and the rule is WHICH SIDE MOVED. The
 * snapshot alone cannot tell a Back from a `router.push` that has not landed
 * yet — in both, the URL names no file while the preview shows one — so each
 * side is compared against what it was, and the side that changed is the cause.
 * When the preview moved the URL is rewritten: opening pushes (on a phone,
 * back is how anyone dismisses a full-screen overlay), closing replaces, so
 * shutting the preview leaves no entry back would re-open. When the URL moved,
 * the preview is opened or shut to match.
 *
 * `onUrlOpen` is the way in for a link: the rows may still be loading, and then
 * it is NOT yet handled — `previousDocRef` is left behind on purpose, so the
 * render that has them still counts as a move.
 */
export function useDocParamSync({
  openId,
  files,
  onUrlOpen,
  onUrlClose,
}: {
  openId: string | null
  files: readonly FileItem[]
  onUrlOpen: (id: string) => void
  onUrlClose: () => void
}): void {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const docParam = searchParams?.get('doc')
  const previousDocRef = useRef<string | null>(null)
  const previousOpenRef = useRef<string | null>(null)

  useEffect(() => {
    const wanted = docParam ?? null
    const urlMoved = previousDocRef.current !== wanted
    const previewMoved = previousOpenRef.current !== openId
    previousOpenRef.current = openId

    if (wanted === openId) {
      previousDocRef.current = wanted
      return
    }

    if (previewMoved) {
      previousDocRef.current = wanted
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      const path = pathname ?? ''
      if (openId === null) {
        params.delete('doc')
        const query = params.toString()
        router.replace(query ? `${path}?${query}` : path, { scroll: false })
      } else {
        params.set('doc', openId)
        router.push(`${path}?${params.toString()}`, { scroll: false })
      }
      return
    }

    if (!urlMoved) return

    if (wanted === null) {
      previousDocRef.current = wanted
      onUrlClose()
      return
    }
    if (!files.some((file) => file.id === wanted)) return
    previousDocRef.current = wanted
    onUrlOpen(wanted)
  }, [docParam, openId, files, onUrlOpen, onUrlClose, pathname, router, searchParams])
}
