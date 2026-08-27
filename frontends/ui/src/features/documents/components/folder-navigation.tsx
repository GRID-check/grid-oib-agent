'use client'

import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Folder, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RaisedCard, RaisedCardBody, RaisedCardFooter, RaisedCardMedia } from '@/components/ui/raised-card'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FolderItem } from './project-file-workspace'

/**
 * Finder-style folder navigation: the drill-down that replaced the tree pane.
 *
 * The tree drew every level at once in a side band and, outside the tree view,
 * nested folders were unreachable at all (the chip row listed top-level
 * folders only). This module makes drilling the ONE model: at each level the
 * folders render as cards (or rows) beside the files, clicking one enters it,
 * and the breadcrumb up top names the path and walks back out. Same flat
 * `FolderItem[]` data, same server API — only the presentation changed.
 */

/** The chain of ancestors from the root to `folderId`, oldest first. */
export function folderPath(folders: FolderItem[], folderId: string | null): FolderItem[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: FolderItem[] = []
  let cursor = folderId === null ? undefined : byId.get(folderId)
  // Defensive bound: a corrupt parent chain must not hang the render.
  while (cursor && path.length <= folders.length) {
    path.unshift(cursor)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
  }
  return path
}

export interface FolderNavProps {
  folders: FolderItem[]
  currentFolderId: string | null
  onNavigate: (id: string | null) => void
  onCreateFolder: (name: string, parentId?: string) => Promise<boolean>
  onRenameFolder: (folderId: string, name: string) => Promise<boolean>
  onDeleteFolder: (folderId: string) => Promise<boolean>
}

/**
 * The path row: `All Files › Planung › Statik`, every ancestor a link, plus
 * the "New folder" control for the level the reader is standing in.
 */
export function FolderBreadcrumbRow({
  folders,
  currentFolderId,
  onNavigate,
  onCreateFolder,
  /** Right-aligned extras (the Archiv has none; Files adds nothing yet). */
  children,
}: Pick<FolderNavProps, 'folders' | 'currentFolderId' | 'onNavigate' | 'onCreateFolder'> & {
  children?: ReactNode
}): JSX.Element {
  const t = useTranslations('files')
  const path = useMemo(() => folderPath(folders, currentFolderId), [folders, currentFolderId])

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
      <Breadcrumb aria-label={t('folders.breadcrumb')} className="min-w-0">
        <BreadcrumbList className="flex-nowrap overflow-x-auto">
          <BreadcrumbItem>
            {currentFolderId === null ? (
              <BreadcrumbPage>{t('folders.allFiles')}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild>
                <button type="button" onClick={() => onNavigate(null)}>
                  {t('folders.allFiles')}
                </button>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {path.map((folder, index) => (
            <Fragment key={folder.id}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {index === path.length - 1 ? (
                  <BreadcrumbPage className="max-w-48 truncate">{folder.name}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      className="max-w-48 truncate"
                      onClick={() => onNavigate(folder.id)}
                    >
                      {folder.name}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        <NewFolderControl currentFolderId={currentFolderId} onCreateFolder={onCreateFolder} />
      </div>
    </div>
  )
}

/**
 * "New folder" as a popover form: name it where you stand, Enter creates it in
 * the CURRENT level. Failure keeps the popover open with the typed name — the
 * workspace surfaces the error toast.
 */
function NewFolderControl({
  currentFolderId,
  onCreateFolder,
}: Pick<FolderNavProps, 'currentFolderId' | 'onCreateFolder'>): JSX.Element {
  const t = useTranslations('files')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const commit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || isCreating) return
    setIsCreating(true)
    const ok = await onCreateFolder(trimmed, currentFolderId ?? undefined)
    setIsCreating(false)
    if (ok) {
      setName('')
      setOpen(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => (isCreating ? undefined : setOpen(next))}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="gap-1.5">
          <FolderPlus className="size-4" aria-hidden />
          {t('folders.newFolder')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <InputGroup>
          <InputGroupAddon align="start" className="left-2">
            <Folder aria-hidden />
          </InputGroupAddon>
          <Input
            autoFocus
            value={name}
            disabled={isCreating}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commit()
            }}
            placeholder={t('folders.namePlaceholder')}
            aria-label={t('folders.newFolderName')}
            aria-busy={isCreating}
            className="h-8 rounded-md pl-8 pr-8"
          />
          {isCreating && (
            <InputGroupAddon align="end">
              <Spinner size="sm" label={t('folders.creating')} />
            </InputGroupAddon>
          )}
        </InputGroup>
      </PopoverContent>
    </Popover>
  )
}

interface FolderTileProps {
  folder: FolderItem
  /** Documents + subfolders directly inside, for the count line. */
  itemCount: number
  onOpen: (id: string) => void
  onRenameFolder: FolderNavProps['onRenameFolder']
  onDeleteFolder: FolderNavProps['onDeleteFolder']
}

/** Shared inline rename field — same in-place contract the tree pane had. */
function FolderNameEditor({
  folder,
  onRenameFolder,
  onDone,
  className,
}: {
  folder: FolderItem
  onRenameFolder: FolderNavProps['onRenameFolder']
  onDone: () => void
  className?: string
}): JSX.Element {
  const t = useTranslations('files')
  const [value, setValue] = useState(folder.name)
  const [isRenaming, setIsRenaming] = useState(false)

  const commit = async (): Promise<void> => {
    const name = value.trim()
    if (isRenaming) return
    if (!name || name === folder.name) {
      onDone()
      return
    }
    setIsRenaming(true)
    const ok = await onRenameFolder(folder.id, name)
    setIsRenaming(false)
    // On failure the field stays open with the typed name intact.
    if (ok) onDone()
  }

  return (
    <InputGroup className={className}>
      <InputGroupAddon align="start" className="left-2">
        <Folder aria-hidden />
      </InputGroupAddon>
      <Input
        autoFocus
        value={value}
        disabled={isRenaming}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
          if (event.key === 'Escape') onDone()
        }}
        aria-label={t('folders.renameLabel', { name: folder.name })}
        aria-busy={isRenaming}
        className="h-8 rounded-md pl-8 pr-8 text-sm"
        data-testid={`folder-rename-input-${folder.id}`}
      />
      {isRenaming && (
        <InputGroupAddon align="end">
          <Spinner size="sm" label={t('folders.renaming')} />
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}

function FolderActionsMenu({
  folder,
  onStartRename,
  onDeleteFolder,
}: {
  folder: FolderItem
  onStartRename: () => void
  onDeleteFolder: FolderNavProps['onDeleteFolder']
}): JSX.Element {
  const t = useTranslations('files')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('folders.actionsFor', { name: folder.name })}
          title={t('folders.actions')}
          className="hover:bg-accent focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-sm transition-opacity duration-snap ease-out focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 pointer-coarse:size-11 motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100"
          data-testid={`folder-actions-${folder.id}`}
        >
          <MoreHorizontal className="size-3.5" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={onStartRename}>
          <Pencil className="size-4" aria-hidden />
          {t('folders.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void onDeleteFolder(folder.id)}
          data-testid={`folder-delete-${folder.id}`}
        >
          <Trash2 className="size-4" aria-hidden />
          {t('folders.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A folder as a grid tile — same raised-card anatomy as {@link FileCard}, so a
 * level's folders and files read as one shelf.
 */
export function FolderCard({
  folder,
  itemCount,
  onOpen,
  onRenameFolder,
  onDeleteFolder,
}: FolderTileProps): JSX.Element {
  const t = useTranslations('files')
  const [editing, setEditing] = useState(false)

  return (
    <RaisedCard className="group" data-testid={`folder-card-${folder.id}`}>
      <RaisedCardBody className="flex-1 p-0">
        <button
          type="button"
          onClick={() => onOpen(folder.id)}
          aria-label={t('folders.openFolder', { name: folder.name })}
          className="focus-visible:ring-ring block w-full rounded-t-[inherit] text-left focus-visible:outline-none focus-visible:ring-2"
        >
          <RaisedCardMedia className="bg-surface-sunken flex h-[124px] min-h-[124px] items-center justify-center">
            <Folder
              className="text-muted-foreground/70 size-12"
              strokeWidth={1.25}
              aria-hidden
            />
          </RaisedCardMedia>
        </button>
        <div className="min-h-[4.5rem] px-3.5 pb-3 pt-[11px]">
          {editing ? (
            <FolderNameEditor
              folder={folder}
              onRenameFolder={onRenameFolder}
              onDone={() => setEditing(false)}
            />
          ) : (
            <>
              <p className="text-foreground truncate text-sm font-medium">{folder.name}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t('folders.items', { count: String(itemCount) })}
              </p>
            </>
          )}
        </div>
      </RaisedCardBody>
      <RaisedCardFooter className="min-h-[30px] justify-end gap-1.5 px-2.5 pb-2 pt-1">
        <FolderActionsMenu
          folder={folder}
          onStartRename={() => setEditing(true)}
          onDeleteFolder={onDeleteFolder}
        />
      </RaisedCardFooter>
    </RaisedCard>
  )
}

/**
 * A folder as a detail-view row — the list view's counterpart to
 * {@link FolderCard}, rendered as a block above the sortable file table (a
 * folder does not sort by size or status, so it does not sit inside it).
 */
export function FolderRow({
  folder,
  itemCount,
  onOpen,
  onRenameFolder,
  onDeleteFolder,
}: FolderTileProps): JSX.Element {
  const t = useTranslations('files')
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <div className="flex items-center gap-2 px-2 py-1">
        <FolderNameEditor
          folder={folder}
          onRenameFolder={onRenameFolder}
          onDone={() => setEditing(false)}
          className="max-w-96 flex-1"
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        'text-muted-foreground hover:bg-accent hover:text-foreground transition-colors duration-snap ease-out motion-reduce:transition-none',
      )}
      data-testid={`folder-row-${folder.id}`}
    >
      <button
        type="button"
        onClick={() => onOpen(folder.id)}
        aria-label={t('folders.openFolder', { name: folder.name })}
        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
      >
        <Folder className="size-4 shrink-0" aria-hidden />
        <span className="text-foreground truncate font-medium">{folder.name}</span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {t('folders.items', { count: String(itemCount) })}
        </span>
      </button>
      <FolderActionsMenu
        folder={folder}
        onStartRename={() => setEditing(true)}
        onDeleteFolder={onDeleteFolder}
      />
    </div>
  )
}
