'use client'

import { useMemo, useState } from 'react'
import type { FolderItem } from './project-file-workspace'
import { Folder, FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'

interface FolderTreePaneProps {
  folders: FolderItem[]
  selectedFolderId: string | null
  onSelectFolder: (id: string | null) => void
  onCreateFolder: (name: string, parentId?: string) => Promise<boolean>
  /**
   * Rename. Resolves false when the name was rejected, and the row stays open
   * with what was typed still in it — the same contract as the create above.
   */
  onRenameFolder?: (folderId: string, name: string) => Promise<boolean>
  /**
   * Delete. The documents inside are re-filed into the parent, never deleted;
   * the workspace's confirm says so before this is called.
   */
  onDeleteFolder?: (folderId: string) => Promise<boolean>
  isLoading: boolean
}

// `undefined` = not creating; `null` = creating at the root; a string = creating
// a subfolder inside that folder id. Nesting is fully supported by the schema
// and API -- this explicit target just makes it discoverable instead of relying
// on the implicitly-selected folder.
type CreateTarget = string | null | undefined

/**
 * The per-row controls. Hidden until the row is hovered or the control itself
 * is focused, and ALWAYS present on a coarse pointer, where there is no hover
 * to reveal them with.
 */
const folderRowActionClass =
  'flex size-7 shrink-0 items-center justify-center rounded-sm transition-opacity duration-snap ease-out hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11 motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100'

export function FolderTreePane({
  folders,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  isLoading,
}: FolderTreePaneProps) {
  const t = useTranslations('files')
  const [createTarget, setCreateTarget] = useState<CreateTarget>(undefined)
  const [newFolderName, setNewFolderName] = useState('')
  /** The folder whose name is being edited in place, and the text so far. */
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
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

  const startRename = (folder: FolderItem) => {
    setRenameValue(folder.name)
    setRenameTarget(folder.id)
  }

  const cancelRename = () => {
    if (isRenaming) return
    setRenameTarget(null)
    setRenameValue('')
  }

  const commitRename = async (folder: FolderItem) => {
    const name = renameValue.trim()
    if (!name || isRenaming || !onRenameFolder) return
    // Nothing typed but the same name: treat it as a cancel rather than a
    // request, so Enter on an untouched field is not a round trip.
    if (name === folder.name) {
      setRenameTarget(null)
      return
    }
    setIsRenaming(true)
    const ok = await onRenameFolder(folder.id, name)
    setIsRenaming(false)
    // On failure the row stays open with the typed name intact — the same
    // contract the create row has, and the reason neither loses your typing.
    if (ok) {
      setRenameTarget(null)
      setRenameValue('')
    }
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

  /**
   * The two in-tree name fields — create and rename — share this.
   *
   * `rounded-md` is the point: `Input` is `rounded-xl`, which on a 32px-tall
   * box reads as a pill sitting between rows that are all `rounded-md`, so the
   * field looked like it belonged to a different surface than the row it stands
   * in for. `pl-8` clears the leading folder icon, which stays with the row so
   * an editing row still reads as a folder rather than as a stray text box.
   */
  const nameFieldClass = 'h-8 rounded-md pl-8 pr-8'

  /**
   * The indent of a name field, against the indent of the row it replaces.
   *
   * A row puts its icon at exactly its `paddingLeft`; a field puts its icon
   * inside a 1px border and its own addon offset, so reusing the row's padding
   * pushed the icon ~10px right and the row visibly jumped sideways the moment
   * it became editable. Dropping the shared 8px and letting the border + `left-2`
   * addon make it back up lands the icon within a pixel of where it was.
   */
  const nameFieldIndent = (depth: number) => ({ paddingLeft: `${depth * 14}px` })

  const rowClass = (active: boolean) =>
    `group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-snap ease-out pointer-coarse:min-h-11 pointer-coarse:py-2 motion-reduce:transition-none ${
      active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    }`

  const renderCreateInput = (depth: number) => (
    <div key={`create-${createTarget ?? 'root'}`} className="pr-2 pt-1" style={nameFieldIndent(depth)}>
      <InputGroup>
        <InputGroupAddon align="start" className="left-2">
          <Folder aria-hidden />
        </InputGroupAddon>
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
          className={nameFieldClass}
        />
        {isCreating && (
          <InputGroupAddon align="end">
            <Spinner size="sm" label={t('folders.creating')} />
          </InputGroupAddon>
        )}
      </InputGroup>
    </div>
  )

  const renderFolderTree = (items: FolderItem[], depth = 0): JSX.Element[] => {
    return items.flatMap((folder) => {
      const children = getChildren(folder.id)
      const active = selectedFolderId === folder.id
      const Icon = active ? FolderOpen : Folder
      const editing = renameTarget === folder.id
      return [
        editing ? (
          // In place, not in a dialog: the reader is looking at the name they
          // want to change, and a modal would take it off screen to ask about
          // it. Same row, same indent, same width as the folder it replaces.
          <div key={folder.id} className="flex items-center gap-1 py-0.5 pr-2" style={nameFieldIndent(depth)}>
            <InputGroup className="h-8">
              <InputGroupAddon align="start" className="left-2">
                <Folder aria-hidden />
              </InputGroupAddon>
              <Input
                autoFocus
                value={renameValue}
                disabled={isRenaming}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => void commitRename(folder)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitRename(folder)
                  if (event.key === 'Escape') cancelRename()
                }}
                aria-label={t('folders.renameLabel', { name: folder.name })}
                className={`${nameFieldClass} text-sm`}
                data-testid={`folder-rename-input-${folder.id}`}
              />
              {isRenaming && (
                <InputGroupAddon align="end">
                  <Spinner size="sm" label={t('folders.renaming')} />
                </InputGroupAddon>
              )}
            </InputGroup>
          </div>
        ) : (
        <div
          key={folder.id}
          className={rowClass(active)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <button
            onClick={() => onSelectFolder(folder.id)}
            aria-pressed={active}
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm pointer-coarse:min-h-11"
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{folder.name}</span>
          </button>
          <button
            onClick={() => startCreate(folder.id)}
            aria-label={t('folders.addSubfolderIn', { name: folder.name })}
            title={t('folders.addSubfolder')}
            className={folderRowActionClass}
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
          {(onRenameFolder || onDeleteFolder) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('folders.actionsFor', { name: folder.name })}
                  title={t('folders.actions')}
                  className={folderRowActionClass}
                  data-testid={`folder-actions-${folder.id}`}
                >
                  <MoreHorizontal className="size-3.5" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {onRenameFolder && (
                  <DropdownMenuItem onSelect={() => startRename(folder)}>
                    <Pencil className="size-4" aria-hidden />
                    {t('folders.rename')}
                  </DropdownMenuItem>
                )}
                {onDeleteFolder && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void onDeleteFolder(folder.id)}
                    data-testid={`folder-delete-${folder.id}`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {t('folders.delete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        ),
        ...(createTarget === folder.id ? [renderCreateInput(depth + 1)] : []),
        ...(children.length > 0 ? renderFolderTree(children, depth + 1) : []),
      ]
    })
  }

  return (
    <div className="flex h-full flex-col gap-1 p-2">
      <SectionLabel as="p" className="px-2 pb-1 pt-1 tracking-widest">
        {t('folders.heading')}
      </SectionLabel>

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
        <div className="space-y-1 px-2 py-1">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="ml-4 h-8 w-1/2" />
          <Skeleton className="ml-4 h-8 w-2/3" />
          <Skeleton className="h-8 w-4/5" />
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
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors duration-snap ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:py-2 motion-reduce:transition-none"
        >
          <Plus className="size-4 shrink-0" aria-hidden />
          <span>{t('folders.newFolder')}</span>
        </button>
      )}
    </div>
  )
}
