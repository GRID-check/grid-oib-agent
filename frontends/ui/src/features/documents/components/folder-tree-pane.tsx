'use client'

import { useMemo, useState } from 'react'
import type { FolderItem } from './project-file-workspace'
import { Folder, FolderOpen, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

interface FolderTreePaneProps {
  folders: FolderItem[]
  selectedFolderId: string | null
  onSelectFolder: (id: string | null) => void
  onCreateFolder: (name: string, parentId?: string) => Promise<boolean>
  isLoading: boolean
}

export function FolderTreePane({
  folders,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  isLoading,
}: FolderTreePaneProps) {
  const [isCreating, setIsCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const rootFolders = useMemo(() => folders.filter((f) => f.parentId === null), [folders])

  const getChildren = (parentId: string) => folders.filter((f) => f.parentId === parentId)

  const handleCreate = async () => {
    if (!newFolderName.trim()) return
    setIsCreating(false)
    const ok = await onCreateFolder(newFolderName.trim(), selectedFolderId ?? undefined)
    if (ok) {
      setNewFolderName('')
    }
  }

  const rowClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
      active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    }`

  const renderFolderTree = (items: FolderItem[], depth = 0): JSX.Element[] => {
    return items.flatMap((folder) => {
      const children = getChildren(folder.id)
      const active = selectedFolderId === folder.id
      const Icon = active ? FolderOpen : Folder
      return [
        <button
          key={folder.id}
          onClick={() => onSelectFolder(folder.id)}
          aria-pressed={active}
          className={rowClass(active)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{folder.name}</span>
        </button>,
        ...(children.length > 0 ? renderFolderTree(children, depth + 1) : []),
      ]
    })
  }

  return (
    <div className="flex h-full flex-col gap-1 p-2">
      <p className="px-2 pb-1 pt-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">Folders</p>

      {/* All Files root */}
      <button
        onClick={() => onSelectFolder(null)}
        aria-pressed={selectedFolderId === null}
        className={rowClass(selectedFolderId === null)}
      >
        <FolderOpen className="size-4 shrink-0" aria-hidden />
        <span className="truncate">All Files</span>
      </button>

      {isLoading ? (
        <div className="space-y-2 px-2 py-1">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="ml-4 h-6 w-1/2" />
          <Skeleton className="ml-4 h-6 w-2/3" />
          <Skeleton className="h-6 w-4/5" />
        </div>
      ) : (
        renderFolderTree(rootFolders)
      )}

      {/* Create folder */}
      {isCreating ? (
        <div className="px-1 pt-1">
          <Input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') {
                setIsCreating(false)
                setNewFolderName('')
              }
            }}
            onBlur={() => {
              if (!newFolderName.trim()) setIsCreating(false)
            }}
            placeholder="Folder name"
            aria-label="New folder name"
            className="h-8"
          />
        </div>
      ) : (
        <button
          onClick={() => setIsCreating(true)}
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4 shrink-0" aria-hidden />
          <span>New folder</span>
        </button>
      )}
    </div>
  )
}
