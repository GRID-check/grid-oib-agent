'use client'

/**
 * Dragging a FILE onto a FOLDER, inside the app.
 *
 * There was already a move — `PATCH /api/documents/[id]/folder`, offered as
 * „Verschieben" in the overflow menu — so this adds no capability. What it adds
 * is the gesture people try first, and the absence of which reads as the
 * capability being missing.
 *
 * The hazard this exists to handle is that the workspace ALREADY listens for
 * drags: dropping files from the desktop is how you upload. An internal drag
 * must therefore be distinguishable from an OS one, and it is, on a fact the
 * browser guarantees rather than on a flag we set: `dataTransfer.types`
 * contains `Files` only for a drag that carries real files. A drag started
 * inside the page carries our own MIME type and no `Files`, so the upload
 * overlay stays down and the folder highlights instead.
 */

import { useCallback, useState } from 'react'

/**
 * Our own drag type. A custom MIME type rather than `text/plain` so a
 * paragraph dragged from another tab cannot look like a document.
 */
export const DOCUMENT_DRAG_TYPE = 'application/x-grid-document-id'

/** True when a drag carries files from outside the browser (an upload). */
export function isExternalFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types ?? []).includes('Files')
}

/** Props for the element being dragged. Spread onto a file card or row. */
export function documentDragProps(documentId: string) {
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, documentId)
      // `move` so the cursor states the outcome. A file goes to one folder; it
      // is not copied into a second one.
      event.dataTransfer.effectAllowed = 'move'
    },
  }
}

interface UseFolderDropTargetOptions {
  /** Move the document into this folder. `null` is the project root. */
  onDropDocument: (documentId: string, folderId: string | null) => void
  folderId: string | null
  /** A folder cannot receive what it already holds, nor can it receive itself. */
  disabled?: boolean
}

/**
 * A folder as a drop target, with the highlight the gesture needs to be
 * legible — without a hover state a drag has no way to say where it will land.
 */
export function useFolderDropTarget({
  onDropDocument,
  folderId,
  disabled = false,
}: UseFolderDropTargetOptions) {
  const [isOver, setIsOver] = useState(false)

  const accepts = useCallback(
    (event: React.DragEvent) =>
      !disabled &&
      !isExternalFileDrag(event.dataTransfer) &&
      Array.from(event.dataTransfer.types ?? []).includes(DOCUMENT_DRAG_TYPE),
    [disabled]
  )

  return {
    isOver,
    dropProps: {
      onDragOver: (event: React.DragEvent) => {
        if (!accepts(event)) return
        // Both, and in this order: without `preventDefault` the browser refuses
        // the drop, and without stopping propagation the workspace's own
        // upload-drop handler also sees it.
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setIsOver(true)
      },
      onDragLeave: (event: React.DragEvent) => {
        event.stopPropagation()
        setIsOver(false)
      },
      onDrop: (event: React.DragEvent) => {
        if (!accepts(event)) return
        event.preventDefault()
        event.stopPropagation()
        setIsOver(false)
        const documentId = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE)
        if (documentId) onDropDocument(documentId, folderId)
      },
    },
  }
}
