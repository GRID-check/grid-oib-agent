'use client'

/**
 * The file operations, as one control.
 *
 * One overflow menu, in the object's own header, is what every file manager
 * people already use does. The items themselves live in
 * {@link documentActionEntries} so a right-click on the same object cannot
 * drift from this ⋯. This file owns the dropdown trigger, the dialogs, and
 * the fetch hook.
 *
 * A surface that already shows one of the operations elsewhere (the preview's
 * own Download) passes `actions` to drop it. The workspace wraps the tile in
 * {@link DocumentObjectMenu} so the same list also opens on right-click.
 */

import { useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { ActionMenu } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'
import { RenameDocumentDialog } from './rename-document-dialog'
import {
  documentActionEntries,
  type DocumentActionKind,
} from './action-entries'
import { useDocumentActions, type ActionableDocument, type DocumentScope } from './use-document-actions'
import type { PathFolder } from '../../lib/folder-path-label'

export type { DocumentActionKind }

/** Overflow-only default: Open / Ask / Copy path belong on the tile, not here. */
const DEFAULT_ACTIONS: readonly DocumentActionKind[] = [
  'download',
  'rename',
  'move',
  'delete',
  'reingest',
]

export type MoveTargetFolder = PathFolder

export interface DocumentActionsMenuProps {
  document: ActionableDocument & { originPath?: string | null }
  scope: DocumentScope
  actions?: readonly DocumentActionKind[]
  canManage?: boolean
  onRenamed?: (documentId: string, displayName: string | null) => void
  onDeleted?: (documentId: string) => void
  onReingested?: (documentId: string, status: string) => void
  folders?: readonly MoveTargetFolder[]
  onMoved?: (documentId: string, folderId: string | null) => void
  onOpen?: () => void
  onAsk?: () => void
  trigger?: ReactNode
  align?: 'start' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function useDocumentActionMenu({
  document,
  scope,
  actions = DEFAULT_ACTIONS,
  canManage = true,
  onRenamed,
  onDeleted,
  onReingested,
  folders,
  onMoved,
  onOpen,
  onAsk,
}: Omit<DocumentActionsMenuProps, 'trigger' | 'align' | 'side'>) {
  const t = useTranslations(scope)
  const filesT = useTranslations('files')
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

  const copyOriginPath = (): void => {
    const path = document.originPath
    if (!path) return
    void navigator.clipboard
      ?.writeText(path)
      .then(() => toast.success(filesT('preview.originPathCopied')))
      .catch(() => toast.error(filesT('preview.originPathCopyFailed')))
  }

  const entries = documentActionEntries({
    document,
    labels: {
      open: t('actions.open'),
      ask: t('actions.ask'),
      download: t('actions.download'),
      rename: t('actions.rename'),
      move: t('actions.move'),
      copyOriginPath: t('actions.copyOriginPath'),
      delete: t('actions.delete'),
      reingest: t('actions.reingest'),
      reingesting: t('actions.reingesting'),
      allFiles: filesT('folders.allFiles'),
    },
    actions,
    canManage,
    folders,
    isDownloading: documentActions.isDownloading,
    isReingesting: documentActions.isReingesting,
    isMoving: documentActions.isMoving,
    onOpen,
    onAsk,
    onDownload: () => void documentActions.download(),
    onRename: () => setRenameOpen(true),
    onDelete: () => setDeleteOpen(true),
    onReingest: () => void documentActions.reingest(),
    onMove: (folderId, folderName) => void documentActions.move(folderId, folderName),
    onCopyOriginPath: document.originPath ? copyOriginPath : undefined,
  })

  const dialogs = (
    <>
      {entries.some((entry) => entry.type === 'item' && entry.id === 'rename') && (
        <RenameDocumentDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          document={document}
          scope={scope}
          onRename={documentActions.rename}
          pending={documentActions.isRenaming}
        />
      )}
      {entries.some((entry) => entry.type === 'item' && entry.id === 'delete') && (
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
            if (await documentActions.remove()) setDeleteOpen(false)
          }}
        />
      )}
    </>
  )

  return { entries, dialogs, name: documentActions.name }
}

export function DocumentActionsMenu({
  trigger,
  align = 'end',
  side = 'bottom',
  ...props
}: DocumentActionsMenuProps): ReactNode {
  const t = useTranslations(props.scope)
  const { entries, dialogs, name } = useDocumentActionMenu(props)
  if (entries.length === 0) return null
  return (
    <>
      <ActionMenu
        mode="dropdown"
        entries={entries}
        align={align}
        side={side}
        trigger={
          trigger ?? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 bg-background/80 shadow-2xs backdrop-blur-sm"
              aria-label={t('actions.label', { name })}
              title={t('actions.menuLabel')}
              data-testid="document-actions-trigger"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          )
        }
      />
      {dialogs}
    </>
  )
}
