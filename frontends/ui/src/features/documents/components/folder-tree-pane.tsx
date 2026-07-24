'use client'

import { useMemo, useState } from 'react'
import type { FolderItem } from './project-file-workspace'
import { Folder, FolderOpen, Loader2, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'

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
  const t = useTranslations('files')
  const [createTarget, setCreateTarget] = useState<CreateTarget>(undefined)
  const [newFolderName, setNewFolderName] = useState('')
  // In-flight signal for the create request. While true the input row stays
  // visible but disabled with a spinner; on failure we keep the row open with
  // the typed name intact so the user doesn't have to retype it.
  const [isCreating, setIsCreating] = useState(false)

  const rootFolders = useMemo(() => folders.filter((f) => f.parentId === null), [folders])

  const getChildren = (parentId: string) => folders.filter((f) => f.parentId === parentId)

  const startCreate = (parentId: string | null) => {
    setNewFolderName('')
    setCreateTarget(parentId)
  }

  const cancelCreate = () => {
    if (isCreating) return
    setCreateTarget(undefined)
    setNewFolderName('')
  }

  const handleCreate = async () => {
    const name = newFolderName.trim()
    if (!name || isCreating) return
    const parentId = createTarget ?? undefined
    // Keep the input row mounted and disabled while the request is in flight.
    setIsCreating(true)
    const ok = await onCreateFolder(name, parentId)
    setIsCreating(false)
    if (ok) {
      // Success: clear and close the input row.
      setNewFolderName('')
      setCreateTarget(undefined)
    }
    // Failure: leave createTarget + newFolderName untouched so the row stays
    // open with the entered name (the workspace surfaces the error toast).
  }

  const rowClass = (active: boolean) =>
    `group flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors md:min-h-0 md:py-1.5 ${
      active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    }`

  const renderCreateInput = (depth: number) => (
    <div key={`create-${createTarget ?? 'root'}`} className="px-1 pt-1" style={{ paddingLeft: `${8 + depth * 14}px` }}>
      <div className="relative">
        <Input
          autoFocus
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate()
            if (e.key === 'Escape') cancelCreate()
          }}
          onBlur={() => {
            if (!isCreating && !newFolderName.trim()) cancelCreate()
          }}
          disabled={isCreating}
          placeholder={t('folders.namePlaceholder')}
          aria-label={t('folders.newFolderName')}
          aria-busy={isCreating}
          className="h-8 pr-8"
        />
        {isCreating && (
          <Loader2
            className="absolute right-2 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-label={t('folders.creating')}
            role="status"
          />
        )}
      </div>
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
            aria-label={t('folders.addSubfolderIn', { name: folder.name })}
            title={t('folders.addSubfolder')}
            className="flex size-11 shrink-0 items-center justify-center rounded-sm transition-opacity hover:bg-background/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-7 md:opacity-0 md:group-hover:opacity-100"
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
      <p className="px-2 pb-1 pt-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">{t('folders.heading')}</p>

      {/* All Files root */}
      <button
        onClick={() => onSelectFolder(null)}
        aria-pressed={selectedFolderId === null}
        className={`${rowClass(selectedFolderId === null)} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      >
        <FolderOpen className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{t('folders.allFiles')}</span>
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
          className="mt-1 flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0 md:py-1.5"
        >
          <Plus className="size-4 shrink-0" aria-hidden />
          <span>{t('folders.newFolder')}</span>
        </button>
      )}
    </div>
  )
}
