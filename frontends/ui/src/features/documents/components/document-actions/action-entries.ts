/**
 * The operations a document menu can offer, as an entry list.
 *
 * Dropdown and right-click both render this. Order is fixed, not per-caller:
 * open and ask first (what you came here to do), then the file operations,
 * then the destructive one set apart. A surface that already shows one of
 * these elsewhere (the preview's own Download) passes `actions` to drop it.
 */

import {
  Check,
  Download,
  Folder,
  FolderInput,
  FolderTree,
  MessageSquareText,
  Pencil,
  RotateCcw,
  Trash2,
  Eye,
} from 'lucide-react'
import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { isFailedStatus } from '../document-status'
import { sortedFolderDestinations, type PathFolder } from '../../lib/folder-path-label'
import type { ActionableDocument } from './use-document-actions'

export type DocumentActionKind =
  | 'open'
  | 'ask'
  | 'download'
  | 'rename'
  | 'move'
  | 'copyOriginPath'
  | 'delete'
  | 'reingest'

export const DEFAULT_DOCUMENT_ACTIONS: readonly DocumentActionKind[] = [
  'open',
  'ask',
  'download',
  'rename',
  'move',
  'copyOriginPath',
  'delete',
  'reingest',
]

export interface DocumentActionLabels {
  open: string
  ask: string
  download: string
  rename: string
  move: string
  copyOriginPath: string
  delete: string
  reingest: string
  reingesting: string
  allFiles: string
}

export interface DocumentActionEntriesInput {
  document: ActionableDocument & { originPath?: string | null }
  labels: DocumentActionLabels
  actions?: readonly DocumentActionKind[]
  canManage?: boolean
  folders?: readonly PathFolder[]
  isDownloading?: boolean
  isReingesting?: boolean
  isMoving?: boolean
  onOpen?: () => void
  onAsk?: () => void
  onDownload: () => void
  onRename: () => void
  onDelete: () => void
  onReingest: () => void
  onMove: (folderId: string | null, folderName: string) => void
  onCopyOriginPath?: () => void
}

export function documentActionEntries({
  document,
  labels,
  actions = DEFAULT_DOCUMENT_ACTIONS,
  canManage = true,
  folders,
  isDownloading = false,
  isReingesting = false,
  isMoving = false,
  onOpen,
  onAsk,
  onDownload,
  onRename,
  onDelete,
  onReingest,
  onMove,
  onCopyOriginPath,
}: DocumentActionEntriesInput): ActionMenuEntry[] {
  const offers = (kind: DocumentActionKind): boolean => {
    if (!actions.includes(kind)) return false
    if (kind === 'download') return true
    if (kind === 'open') return Boolean(onOpen)
    if (kind === 'ask') return Boolean(onAsk)
    if (kind === 'copyOriginPath') {
      return Boolean(document.originPath && onCopyOriginPath)
    }
    if (kind === 'reingest') return canManage && isFailedStatus(document.status)
    if (kind === 'move') return canManage && Boolean(folders && folders.length > 0)
    return canManage
  }

  const entries: ActionMenuEntry[] = []
  const pushSep = (): void => {
    if (entries.length > 0 && entries[entries.length - 1]?.type !== 'separator') {
      entries.push({ type: 'separator' })
    }
  }

  if (offers('open') && onOpen) {
    entries.push({
      type: 'item',
      id: 'open',
      label: labels.open,
      icon: Eye,
      onSelect: onOpen,
      testId: 'document-action-open',
    })
  }
  if (offers('ask') && onAsk) {
    entries.push({
      type: 'item',
      id: 'ask',
      label: labels.ask,
      icon: MessageSquareText,
      onSelect: onAsk,
      testId: 'document-action-ask',
    })
  }

  if (offers('reingest')) {
    pushSep()
    entries.push({
      type: 'item',
      id: 'reingest',
      label: isReingesting ? labels.reingesting : labels.reingest,
      icon: RotateCcw,
      disabled: isReingesting,
      onSelect: onReingest,
      testId: 'document-action-reingest',
    })
  }

  if (offers('download') || offers('rename') || offers('move') || offers('copyOriginPath')) {
    pushSep()
  }

  if (offers('download')) {
    entries.push({
      type: 'item',
      id: 'download',
      label: labels.download,
      icon: Download,
      disabled: isDownloading,
      onSelect: onDownload,
      testId: 'document-action-download',
    })
  }
  if (offers('rename')) {
    entries.push({
      type: 'item',
      id: 'rename',
      label: labels.rename,
      icon: Pencil,
      onSelect: onRename,
      testId: 'document-action-rename',
    })
  }
  if (offers('move') && folders) {
    const destinations = sortedFolderDestinations(folders)
    const current = document.folderId ?? null
    entries.push({
      type: 'sub',
      id: 'move',
      label: labels.move,
      icon: FolderInput,
      testId: 'document-action-move',
      items: [
        {
          type: 'item',
          id: 'move-root',
          label: labels.allFiles,
          icon: current === null ? Check : Folder,
          disabled: isMoving || current === null,
          onSelect: () => onMove(null, labels.allFiles),
          testId: 'document-move-root',
        },
        ...destinations.map(({ folder, label }) => {
          const here = document.folderId === folder.id
          return {
            type: 'item' as const,
            id: `move-${folder.id}`,
            label,
            icon: here ? Check : Folder,
            disabled: isMoving || here,
            onSelect: () => onMove(folder.id, label),
          }
        }),
      ],
    })
  }
  if (offers('copyOriginPath') && onCopyOriginPath) {
    entries.push({
      type: 'item',
      id: 'copy-origin',
      label: labels.copyOriginPath,
      icon: FolderTree,
      onSelect: onCopyOriginPath,
      testId: 'document-action-copy-origin',
    })
  }

  if (offers('delete')) {
    pushSep()
    entries.push({
      type: 'item',
      id: 'delete',
      label: labels.delete,
      icon: Trash2,
      variant: 'destructive',
      onSelect: onDelete,
      testId: 'document-action-delete',
    })
  }

  return entries
}
