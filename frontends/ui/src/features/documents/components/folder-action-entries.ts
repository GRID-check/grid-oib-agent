/**
 * Operations on a folder, as the same entry list the ⋯ and the right-click
 * both render. Open and "new folder inside" first; rename and move in the
 * middle; delete set apart.
 */

import { Check, Folder, FolderInput, FolderPlus, Pencil, Trash2, Eye } from 'lucide-react'
import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { sortedFolderDestinations, type PathFolder } from '../lib/folder-path-label'

export interface FolderActionLabels {
  open: string
  newInside: string
  rename: string
  move: string
  delete: string
  allFiles: string
}

export interface FolderActionEntriesInput {
  folder: PathFolder
  labels: FolderActionLabels
  folders?: readonly PathFolder[]
  canAcceptMove?: (targetFolderId: string | null) => boolean
  isMoving?: boolean
  onOpen: () => void
  onNewInside?: () => void
  onRename: () => void
  onMove?: (parentId: string | null, parentName: string) => void
  onDelete: () => void
}

export function folderActionEntries({
  folder,
  labels,
  folders,
  canAcceptMove,
  isMoving = false,
  onOpen,
  onNewInside,
  onRename,
  onMove,
  onDelete,
}: FolderActionEntriesInput): ActionMenuEntry[] {
  const entries: ActionMenuEntry[] = [
    {
      type: 'item',
      id: 'open',
      label: labels.open,
      icon: Eye,
      onSelect: onOpen,
      testId: `folder-action-open-${folder.id}`,
    },
  ]

  if (onNewInside) {
    entries.push({
      type: 'item',
      id: 'new-inside',
      label: labels.newInside,
      icon: FolderPlus,
      onSelect: onNewInside,
      testId: `folder-action-new-${folder.id}`,
    })
  }

  entries.push({ type: 'separator' })
  entries.push({
    type: 'item',
    id: 'rename',
    label: labels.rename,
    icon: Pencil,
    onSelect: onRename,
    testId: `folder-action-rename-${folder.id}`,
  })

  if (onMove && folders && folders.length > 0) {
    const destinations = sortedFolderDestinations(folders).filter(
      ({ folder: dest }) => dest.id !== folder.id,
    )
    const current = folder.parentId ?? null
    const rootOk = canAcceptMove ? canAcceptMove(null) : current !== null
    entries.push({
      type: 'sub',
      id: 'move',
      label: labels.move,
      icon: FolderInput,
      testId: `folder-action-move-${folder.id}`,
      items: [
        {
          type: 'item',
          id: 'move-root',
          label: labels.allFiles,
          icon: current === null ? Check : Folder,
          disabled: isMoving || !rootOk || current === null,
          onSelect: () => onMove(null, labels.allFiles),
          testId: `folder-move-root-${folder.id}`,
        },
        ...destinations.map(({ folder: dest, label }) => {
          const here = current === dest.id
          const allowed = canAcceptMove ? canAcceptMove(dest.id) : !here
          return {
            type: 'item' as const,
            id: `move-${dest.id}`,
            label,
            icon: here ? Check : Folder,
            disabled: isMoving || here || !allowed,
            onSelect: () => onMove(dest.id, label),
          }
        }),
      ],
    })
  }

  entries.push({ type: 'separator' })
  entries.push({
    type: 'item',
    id: 'delete',
    label: labels.delete,
    icon: Trash2,
    variant: 'destructive',
    onSelect: onDelete,
    testId: `folder-delete-${folder.id}`,
  })

  return entries
}
