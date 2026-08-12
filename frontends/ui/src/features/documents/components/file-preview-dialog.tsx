'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from '@/i18n'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { DocumentScope } from './document-actions'
import type { FileItem } from './project-file-workspace'
import { FilePreviewPane } from './file-preview-pane'

interface FilePreviewDialogProps {
  /** The document to preview; `null` closes the dialog. */
  file: FileItem | null
  onClose: () => void
  projectId?: string
  projectName?: string
  canManage?: boolean
  /** Which corpus this document belongs to — decides the file operations' route. */
  scope?: DocumentScope
  onReingested?: (fileId: string, status: string) => void
  onTagsUpdated?: (fileId: string, tags: string[]) => void
  /** The document was renamed in the pane's header menu. */
  onRenamed?: (fileId: string, displayName: string | null) => void
  /** The document was deleted in the pane's header menu. */
  onDeleted?: (fileId: string) => void
  showMetadataPanel?: boolean
}

/**
 * The ONE way a document preview opens across the app — a centered modal hosting
 * {@link FilePreviewPane}. The Files workspace used to open a centered modal
 * while the Archiv opened a docked side column, so the same file looked
 * different depending on where you clicked it. This unifies both.
 *
 * Built on the shared Radix `Dialog` rather than a hand-rolled `fixed inset-0`.
 * That was not a refactor for tidiness: the hand-rolled version had **no focus
 * trap** — the one item from the accessibility audit that was never closed —
 * so Tab walked straight out of the open modal into the page behind it. Radix
 * brings the trap, the portal, scroll locking, Escape, and the `data-[state]`
 * enter/exit animation, and removes the duplicate Escape listener the workspace
 * had to register alongside this one.
 *
 * Two token fixes ride along, both previously raw values that ignored the
 * design language: the scrim is now `--overlay` (which composites correctly in
 * dark mode, where the old `black/45` erased the page rather than dimming it)
 * and the elevation is `shadow-lg` → `--elevation-lg`, the modal token. The old
 * `shadow-2xl` was unmapped and fell through to Tailwind's stock hard shadow.
 *
 * Motion is deliberately the Dialog default — a 200ms fade with a 95% zoom.
 * The panel grows from the centre as one object, which reads as "this opened"
 * rather than "something slid in from somewhere". Reduced motion collapses it
 * to an instant state change via the global rule in `globals.css`.
 */
export function FilePreviewDialog({
  file,
  onClose,
  projectId,
  projectName,
  canManage,
  scope = 'files',
  onReingested,
  onTagsUpdated,
  onRenamed,
  onDeleted,
  showMetadataPanel,
}: FilePreviewDialogProps) {
  const t = useTranslations('files')

  /**
   * Where keyboard focus was when this opened, so closing can put it back.
   *
   * Radix restores focus to its `DialogTrigger`, and this dialog has none: it is
   * opened imperatively from five places by setting state (`file` non-null), so
   * there was no element to return to and Escape dropped focus to the document
   * body. A keyboard user closing a preview landed at the top of the page,
   * having lost the card they were on — in all five surfaces.
   *
   * Captured HERE rather than threaded in as an opener ref from each caller.
   * `document.activeElement` at open time IS the opener — the card, chip or menu
   * item the user activated — so one change fixes every call site, including the
   * next one, and no caller has to remember to wire anything. A programmatic open
   * has no opener, and restoring to wherever focus actually was is still the
   * right answer there.
   */
  const openerRef = useRef<HTMLElement | null>(null)
  const isOpen = file !== null

  useEffect(() => {
    if (isOpen) {
      const active = document.activeElement
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
  }, [isOpen])

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      {file && (
        <DialogContent
          // Definite height, not `max-h-full` — the pane needs a bounded panel
          // so its scroll chain (body + both columns) has something to bite
          // against. Mobile: a full-screen sheet. Desktop: centred, capped.
          //
          // `sm:max-w-[960px]` MUST carry the `sm:` prefix: DialogContent's base
          // class ends in `sm:max-w-lg`, so a plain `max-w-*` loses to it at the
          // exact breakpoint where it matters (see pdf-viewer-dialog.tsx).
          className="flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col gap-0 overflow-hidden rounded-none border p-0 sm:h-[85vh] sm:max-h-[85vh] sm:max-w-[960px] sm:rounded-2xl"
          // The pane draws its own close control in the header, beside the
          // actions it belongs with. A second floating X would be two controls
          // for one job.
          showCloseButton={false}
          // Radix focuses the first focusable child on open, which here is
          // Download — so opening a file to LOOK at it left a download button
          // visibly armed under a focus ring, one Enter away. Focus the panel
          // instead: Escape still closes, Tab still enters the controls in
          // order, and nothing is pre-selected.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus()
          }}
          // Return focus where it came from. Radix's default is the trigger, and
          // there is no trigger here (see `openerRef`), so without this Escape
          // left focus on the document body — the card the user was on, gone.
          //
          // Guarded on the element still being connected: the opener may have
          // been unmounted by whatever the dialog did (deleting the document is
          // one of its actions), and focusing a detached node silently does
          // nothing while suppressing Radix's fallback. Prevent the default only
          // when there is somewhere better to go.
          onCloseAutoFocus={(event) => {
            const opener = openerRef.current
            if (!opener?.isConnected) return
            event.preventDefault()
            opener.focus()
          }}
        >
          {/* Radix requires a title for the accessible name. The pane renders
              the filename visually, so this one is screen-reader only. */}
          <DialogTitle className="sr-only">
            {t('preview.dialogLabel', { name: documentDisplayName(file) })}
          </DialogTitle>

          <FilePreviewPane
            file={file}
            projectId={projectId}
            projectName={projectName}
            canManage={canManage}
            scope={scope}
            onClose={onClose}
            onReingested={onReingested}
            onTagsUpdated={onTagsUpdated}
            onRenamed={onRenamed}
            onDeleted={onDeleted}
            showMetadataPanel={showMetadataPanel}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}
