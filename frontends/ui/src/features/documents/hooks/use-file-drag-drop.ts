/**
 * Drag-and-drop UPLOAD — files from the desktop onto the workspace.
 *
 * Drag state and the handlers for it. Validation happens in `uploadFiles`, not
 * here.
 *
 * ## It answers for uploads only, and that is new
 *
 * The same surface is also where a document is dragged onto a folder, and this
 * hook used to raise its full-surface overlay for ANY drag with items on it —
 * which an in-app drag has, because our own MIME type is an item. So aiming a
 * document at a folder covered that folder in „Dateien hier ablegen", and the
 * move it was about to make read as broken.
 *
 * Every handler now asks {@link isExternalFileDrag} first, which is the same
 * question the folder drop targets ask, from the same module. `Files` in
 * `dataTransfer.types` is a fact the browser guarantees for a drag carrying
 * real files and never sets for one started inside the page.
 *
 * The guard is on ENTER AND LEAVE deliberately. The counter below pairs them,
 * so a leave that is counted after an enter that was not would drive it
 * negative and leave the overlay stuck on the next real upload.
 */

import { useCallback, useRef, useState } from 'react'
import { useAppConfig } from '@/shared/context'
import { checkDraggedFilesSupported } from '../validation'
import { isExternalFileDrag } from './use-document-drag'
import { asPathStampedFiles, readDroppedTree } from '../lib/dropped-entries'

interface UseFileDragDropOptions {
  /** Callback when files are dropped */
  onDrop: (files: File[]) => void
  /** Whether drag-drop is disabled */
  disabled?: boolean
}

interface UseFileDragDropReturn {
  /** Whether files are being dragged over the drop zone */
  isDragging: boolean
  /** Whether dragged files contain unsupported types */
  isUnsupportedDrag: boolean
  /** Event handlers to spread on the drop zone element */
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

/**
 * Hook for handling drag-and-drop file uploads.
 * Provides drag state for UI feedback and passes dropped files to onDrop callback.
 */
export function useFileDragDrop({
  onDrop,
  disabled = false,
}: UseFileDragDropOptions): UseFileDragDropReturn {
  const [isDragging, setIsDragging] = useState(false)
  const [isUnsupportedDrag, setIsUnsupportedDrag] = useState(false)
  const dragCounterRef = useRef(0)
  const { fileUpload: fileUploadConfig } = useAppConfig()

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (disabled) return

      // Not an upload — a document or a folder being moved inside the page.
      // Left alone entirely: the folder under the pointer is the target, and
      // this overlay would sit on top of it saying something else.
      if (!isExternalFileDrag(e.dataTransfer)) return

      dragCounterRef.current++
      setIsDragging(true)
      // Quick MIME check, for the affordance only.
      const allSupported = checkDraggedFilesSupported(e.dataTransfer, fileUploadConfig)
      setIsUnsupportedDrag(!allSupported)
    },
    [disabled, fileUploadConfig]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Paired with the enter above: a leave this hook never counted must not be
    // subtracted, or the counter goes negative and the overlay never clears.
    if (!isExternalFileDrag(e.dataTransfer)) return
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
      setIsUnsupportedDrag(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // An in-app drag is answered by the folder under the pointer, which calls
    // `preventDefault` itself. Doing it here as well would make the whole
    // workspace a valid drop target for a move, so a document released between
    // two folder tiles would read as accepted and do nothing.
    if (!isExternalFileDrag(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      // Before `preventDefault`, which is what claims a drop. A move that
      // missed its folder is not this surface's to accept: the document stays
      // where it is, and `useWindowDragGuard` is what stops the browser doing
      // anything with the release.
      if (!isExternalFileDrag(e.dataTransfer)) return

      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      setIsUnsupportedDrag(false)
      dragCounterRef.current = 0

      if (disabled) return

      // A DROPPED FOLDER IS INVISIBLE TO `dataTransfer.files`.
      //
      // The browser reports directories only through the entries API, and only
      // from within the drop event — so dragging a project folder onto the file
      // area used to do nothing at all, silently: the overlay appeared, the
      // finger let go, and the page carried on. `readDroppedTree` must capture
      // its entries synchronously for that reason; it is called before any
      // await here and returns null when the browser exposes none, which is
      // the signal to use the list below exactly as this always did.
      const transfer = e.dataTransfer
      void (async () => {
        const tree = await readDroppedTree(transfer)
        if (tree) {
          onDrop(asPathStampedFiles(tree))
          return
        }
        const files = Array.from(transfer.files)
        if (files.length === 0) return
        // Validation happens in uploadFiles.
        onDrop(files)
      })()
    },
    [disabled, onDrop]
  )

  return {
    isDragging,
    isUnsupportedDrag,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    },
  }
}
