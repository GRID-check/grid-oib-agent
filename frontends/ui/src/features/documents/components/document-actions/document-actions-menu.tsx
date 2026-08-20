'use client'

/**
 * The file operations, as one control.
 *
 * ## Why a menu, and why exactly here
 *
 * Before this, deleting was a full-width red button that lived in the preview's
 * metadata rail, below the tags, and expanded IN PLACE into a confirm/cancel
 * row — so the most dangerous operation in the product was also the loudest
 * thing on a panel whose job is to describe a document, and the confirmation
 * was a strip of UI that pushed the rest of the column down rather than a
 * decision the reader had to answer. Renaming did not exist at all, on any
 * surface.
 *
 * One overflow menu, in the object's own header, is what every file manager
 * people already use does — Nielsen's "consistency and standards" is not a
 * preference for the familiar, it is the observation that a control someone has
 * used ten thousand times elsewhere costs them nothing to learn here. It also
 * keeps the destructive action out of reach of a stray tap while leaving it
 * exactly one predictable click away.
 *
 * ## The parts, and what each is for
 *
 * - the TRIGGER is the caller's, so the viewport can hand in a glass pill and
 *   the preview a ghost icon button without either surface duplicating the menu;
 * - the MENU lists only operations the surface does not already show (the
 *   preview keeps its own prominent Download, so it asks for rename + delete);
 * - RENAME opens {@link RenameDocumentDialog} — reversible, so it is not
 *   guarded, only explained;
 * - DELETE opens the shared {@link ConfirmDialog}, destructive tone, with the
 *   document named in the question. Irreversible operations get a decision, not
 *   an inline expansion: focus is trapped, Escape cancels, and the dialog
 *   cannot be dismissed mid-request.
 *
 * Nothing here fetches. {@link useDocumentActions} owns that, which is what lets
 * a surface drive the same operations from its own chrome.
 */

import { useState, type ReactNode } from 'react'
import { Check, Download, Folder, FolderInput, MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { RenameDocumentDialog } from './rename-document-dialog'
import { isFailedStatus } from '../document-status'
import { useDocumentActions, type ActionableDocument, type DocumentScope } from './use-document-actions'

/** One operation the menu can carry. Order in the menu is fixed, not per-caller. */
export type DocumentActionKind = 'download' | 'rename' | 'move' | 'delete' | 'reingest'

const DEFAULT_ACTIONS: readonly DocumentActionKind[] = [
  'download',
  'rename',
  'move',
  'delete',
  'reingest',
]

/** The least the menu needs to offer a folder as a destination. */
export interface MoveTargetFolder {
  id: string
  name: string
  parentId: string | null
}

/**
 * A folder's full path, for a flat list of destinations.
 *
 * The submenu is deliberately flat rather than a nested cascade: picking a
 * destination is one decision, and making the reader walk the tree to reach a
 * folder they can already name turns it into several. `Brandschutz / Fluchtwege`
 * says where it is without asking them to travel there.
 */
function folderLabel(folder: MoveTargetFolder, byId: Map<string, MoveTargetFolder>): string {
  const parts = [folder.name]
  let parentId = folder.parentId
  // Bounded by the map size: a cycle cannot outlast the folders that exist.
  for (let hops = 0; parentId && hops < byId.size; hops += 1) {
    const parent = byId.get(parentId)
    if (!parent) break
    parts.unshift(parent.name)
    parentId = parent.parentId
  }
  return parts.join(' / ')
}

export interface DocumentActionsMenuProps {
  document: ActionableDocument
  /** Which corpus — decides the delete route and the words. */
  scope: DocumentScope
  /**
   * Which operations to offer, in case the surface already shows one of them
   * elsewhere (the preview pane has its own Download button in the same header;
   * two controls for one job is worse than a shorter menu). Rendered in the
   * fixed order above whatever order they are passed in.
   */
  actions?: readonly DocumentActionKind[]
  /**
   * Whether the viewer may mutate the document. A read-only viewer (an Archiv
   * member without `org:archiv:manage`) keeps download and loses the rest; with
   * nothing left to show, the menu renders nothing rather than an empty one.
   */
  canManage?: boolean
  onRenamed?: (documentId: string, displayName: string | null) => void
  onDeleted?: (documentId: string) => void
  /** The document was sent back through ingestion; carries the new status. */
  onReingested?: (documentId: string, status: string) => void
  /**
   * The project's folders, which is what makes `move` offerable at all.
   *
   * Omitted (or empty) on a surface with no folder tree behind it — the Archiv,
   * the model viewport — and the move quietly is not offered, rather than
   * opening an empty submenu.
   */
  folders?: readonly MoveTargetFolder[]
  /** The document was re-filed; `null` means the project root. */
  onMoved?: (documentId: string, folderId: string | null) => void
  /** Replaces the default ghost icon button (e.g. the viewport's glass pill). */
  trigger?: ReactNode
  /** Where the menu opens relative to the trigger. */
  align?: 'start' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function DocumentActionsMenu({
  document,
  scope,
  actions = DEFAULT_ACTIONS,
  canManage = true,
  onRenamed,
  onDeleted,
  onReingested,
  folders,
  onMoved,
  trigger,
  align = 'end',
  side = 'bottom',
}: DocumentActionsMenuProps) {
  const t = useTranslations(scope)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const documentActions = useDocumentActions({
    document,
    scope,
    onRenamed,
    onDeleted,
    onReingested,
    onMoved,
  })

  const offers = (kind: DocumentActionKind) => {
    if (!actions.includes(kind)) return false
    if (kind === 'download') return true
    // Only for a document that actually failed — a "try again" on a healthy
    // one is an invitation to re-run an expensive pipeline for nothing.
    if (kind === 'reingest') return canManage && isFailedStatus(document.status)
    // Nowhere to move it TO is not a disabled control, it is no control.
    if (kind === 'move') return canManage && Boolean(folders && folders.length > 0)
    return canManage
  }

  const folderIndex = new Map((folders ?? []).map((folder) => [folder.id, folder]))
  const destinations = (folders ?? [])
    .map((folder) => ({ folder, label: folderLabel(folder, folderIndex) }))
    .sort((a, b) => a.label.localeCompare(b.label))

  // A menu with nothing in it is a control that lies about being one.
  if (
    !offers('download') &&
    !offers('rename') &&
    !offers('move') &&
    !offers('delete') &&
    !offers('reingest')
  ) {
    return null
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              // The 80% alpha is load-bearing, not a hand-derived surface:
              // this trigger floats over a document thumbnail, and with
              // `backdrop-blur-sm` it frosts the page image underneath instead
              // of punching an opaque hole in it (same pair as the status
              // badge on `file-card.tsx`).
              className="size-8 shrink-0 bg-background/80 shadow-2xs backdrop-blur-sm"
              aria-label={t('actions.label', { name: documentActions.name })}
              title={t('actions.menuLabel')}
              data-testid="document-actions-trigger"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} side={side} className="w-56">
          {offers('reingest') && (
            <DropdownMenuItem
              onSelect={() => void documentActions.reingest()}
              disabled={documentActions.isReingesting}
              data-testid="document-action-reingest"
            >
              <RotateCcw className="size-4" aria-hidden />
              {documentActions.isReingesting ? t('actions.reingesting') : t('actions.reingest')}
            </DropdownMenuItem>
          )}
          {offers('reingest') && (offers('download') || offers('rename') || offers('move')) && (
            <DropdownMenuSeparator />
          )}
          {offers('download') && (
            <DropdownMenuItem
              onSelect={() => void documentActions.download()}
              disabled={documentActions.isDownloading}
              data-testid="document-action-download"
            >
              <Download className="size-4" aria-hidden />
              {t('actions.download')}
            </DropdownMenuItem>
          )}
          {offers('rename') && (
            <DropdownMenuItem onSelect={() => setRenameOpen(true)} data-testid="document-action-rename">
              <Pencil className="size-4" aria-hidden />
              {t('actions.rename')}
            </DropdownMenuItem>
          )}
          {offers('move') && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="document-action-move">
                <FolderInput className="size-4" aria-hidden />
                {t('actions.move')}
              </DropdownMenuSubTrigger>
              {/* Bounded and scrollable: a project with sixty folders must not
                  produce a menu taller than the window. */}
              <DropdownMenuSubContent className="max-h-72 w-64 overflow-y-auto">
                <DropdownMenuItem
                  disabled={documentActions.isMoving || (document.folderId ?? null) === null}
                  onSelect={() => void documentActions.move(null, t('folders.allFiles'))}
                  data-testid="document-move-root"
                >
                  {(document.folderId ?? null) === null ? (
                    <Check className="size-4" aria-hidden />
                  ) : (
                    <Folder className="size-4" aria-hidden />
                  )}
                  {t('folders.allFiles')}
                </DropdownMenuItem>
                {destinations.map(({ folder, label }) => {
                  const here = document.folderId === folder.id
                  return (
                    <DropdownMenuItem
                      key={folder.id}
                      disabled={documentActions.isMoving || here}
                      onSelect={() => void documentActions.move(folder.id, label)}
                    >
                      {here ? (
                        <Check className="size-4 shrink-0" aria-hidden />
                      ) : (
                        <Folder className="size-4 shrink-0" aria-hidden />
                      )}
                      <span className="truncate" title={label}>
                        {label}
                      </span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {offers('delete') && (
            <>
              {/* The separator is the point: the destructive item is not one
                  more row in a list of equals. */}
              {(offers('download') || offers('rename') || offers('move')) && <DropdownMenuSeparator />}
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
                data-testid="document-action-delete"
              >
                <Trash2 className="size-4" aria-hidden />
                {t('actions.delete')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {offers('rename') && (
        <RenameDocumentDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          document={document}
          scope={scope}
          onRename={documentActions.rename}
          pending={documentActions.isRenaming}
        />
      )}

      {offers('delete') && (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t('delete.title', { name: documentActions.name })}
          description={t('delete.confirm')}
          confirmLabel={documentActions.isDeleting ? t('delete.deleting') : t('delete.confirmAction')}
          cancelLabel={t('delete.cancel')}
          pending={documentActions.isDeleting}
          confirmTestId="document-delete-confirm"
          onConfirm={async () => {
            // The dialog closes on success only. A failed delete leaves it open
            // beside its own error toast, which is the state the reader can act
            // on — the alternative is a dialog that vanishes and a document that
            // is still there.
            if (await documentActions.remove()) setDeleteOpen(false)
          }}
        />
      )}
    </>
  )
}
