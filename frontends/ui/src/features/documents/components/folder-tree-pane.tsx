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

// `undefined` = not creating; `null` = creating at the root; a string = creating
// a subfolder inside that folder id. Nesting is fully supported by the schema
// and API -- this explicit target just makes it discoverable instead of relying
// on the implicitly-selected folder.
type CreateTarget = string | null | undefined

export function FolderTreePane({
  folders,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  isLoading,
}: FolderTreePaneProps) {
  const [createTarget, setCreateTarget] = useState<CreateTarget>(undefined)
  const [newFolderName, setNewFolderName] = useState('')

  const rootFolders = useMemo(() => folders.filter((f) => f.parentId === null), [folders])

  const getChildren = (parentId: string) => folders.filter((f) => f.parentId === parentId)

  const startCreate = (parentId: string | null) => {
    setNewFolderName('')
    setCreateTarget(parentId)
  }

  const cancelCreate = () => {
    setCreateTarget(undefined)
    setNewFolderName('')
  }

  const handleCreate = async () => {
    if (!newFolderName.trim()) return
    const parentId = createTarget ?? undefined
    setCreateTarget(undefined)
    const ok = await onCreateFolder(newFolderName.trim(), parentId)
    if (ok) {
      setNewFolderName('')
    }
  }

  const rowClass = (active: boolean) =>
    `group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
      active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    }`

  const renderCreateInput = (depth: number) => (
    <div key={`create-${createTarget ?? 'root'}`} className="px-1 pt-1" style={{ paddingLeft: `${8 + depth * 14}px` }}>
      <Input
        autoFocus
        value={newFolderName}
        onChange={(e) => setNewFolderName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCreate()
          if (e.key === 'Escape') cancelCreate()
        }}
        onBlur={() => {
          if (!newFolderName.trim()) cancelCreate()
        }}
        placeholder="Folder name"
        aria-label="New folder name"
        className="h-8"
      />
    </div>
  )

  const renderFolderTree = (items: FolderItem[], depth = 0): JSX.Element[] => {
    return items.flatMap((folder) => {
      const children = getChildren(folder.id)
      const active = selectedFolderId === folder.id
      const Icon = active ? FolderOpen : Folder
      return [
        <div
          key={folder.id}
          className={rowClass(active)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <button
            onClick={() => onSelectFolder(folder.id)}
            aria-pressed={active}
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{folder.name}</span>
          </button>
          <button
            onClick={() => startCreate(folder.id)}
            aria-label={`Add subfolder in ${folder.name}`}
            title="Add subfolder"
            className="shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-background/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </div>,
        ...(createTarget === folder.id ? [renderCreateInput(depth + 1)] : []),
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
        className={`${rowClass(selectedFolderId === null)} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
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

      {/* Create a top-level folder */}
      {createTarget === null ? (
        renderCreateInput(0)
      ) : (
        <button
          onClick={() => startCreate(null)}
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4 shrink-0" aria-hidden />
          <span>New folder</span>
        </button>
      )}
    </div>
  )
}
