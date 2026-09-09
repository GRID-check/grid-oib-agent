'use client'

/**
 * A folder tile's ⋯ and right-click, sharing {@link folderActionEntries}.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { ActionMenu } from '@/components/ui/action-menu'
import { useTranslations } from '@/i18n'
import { folderActionEntries } from './folder-action-entries'
import type { PathFolder } from '../lib/folder-path-label'

const TriggerContext = createContext<ReactNode>(null)

export function FolderActionsTrigger(): ReactNode {
  return useContext(TriggerContext)
}

export interface FolderObjectMenuProps {
  folder: PathFolder
  folders: readonly PathFolder[]
  canAcceptMove?: (targetFolderId: string | null) => boolean
  onOpen: () => void
  onNewInside?: () => void
  onRename: () => void
  onMove?: (parentId: string | null, parentName: string) => void
  onDelete: () => void
  children: ReactNode
}

export function FolderObjectMenu({
  folder,
  folders,
  canAcceptMove,
  onOpen,
  onNewInside,
  onRename,
  onMove,
  onDelete,
  children,
}: FolderObjectMenuProps): ReactNode {
  const t = useTranslations('files')
  const entries = useMemo(
    () =>
      folderActionEntries({
        folder,
        labels: {
          open: t('folders.open'),
          newInside: t('folders.newInside'),
          rename: t('folders.rename'),
          move: t('folders.move'),
          delete: t('folders.delete'),
          allFiles: t('folders.allFiles'),
        },
        folders,
        canAcceptMove,
        onOpen,
        onNewInside,
        onRename,
        onMove,
        onDelete,
      }),
    [
      folder,
      folders,
      canAcceptMove,
      onOpen,
      onNewInside,
      onRename,
      onMove,
      onDelete,
      t,
    ],
  )

  const trigger = (
    <ActionMenu
      mode="dropdown"
      entries={entries}
      trigger={
        <button
          type="button"
          aria-label={t('folders.actionsFor', { name: folder.name })}
          title={t('folders.actions')}
          className="hover:bg-accent focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-sm transition-opacity duration-snap ease-out focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 pointer-coarse:size-11 motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100"
          data-testid={`folder-actions-${folder.id}`}
        >
          <MoreHorizontal className="size-3.5" aria-hidden />
        </button>
      }
    />
  )

  return (
    <TriggerContext.Provider value={trigger}>
      <ActionMenu mode="context" entries={entries}>
        {children}
      </ActionMenu>
    </TriggerContext.Provider>
  )
}
