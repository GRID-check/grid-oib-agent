'use client'

import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'

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
import { Spinner } from '@/components/ui/spinner'
import { AnimatePresence, motion, motionQuick } from '@/components/motion'
import { useTranslations } from '@/i18n'
import { useLocale } from '@/i18n'
import { cn } from '@/lib/utils'
import { TimeAgo } from '@/components/ui/time-ago'
import { GridTileBody, GridTileFooter, GridTileMedia, GridTileShell } from './grid-tile'
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
    <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card/50 px-4 py-2.5 backdrop-blur-sm">
      <Breadcrumb aria-label={t('folders.breadcrumb')} className="min-w-0">
        <BreadcrumbList className="flex-nowrap overflow-x-auto">
          <BreadcrumbItem>
            {currentFolderId === null ? (
              <BreadcrumbPage className="font-medium">{t('folders.allFiles')}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild>
                <button
                  type="button"
                  onClick={() => onNavigate(null)}
                  className="hover:text-foreground transition-colors"
                >
                  {t('folders.allFiles')}
                </button>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          <AnimatePresence initial={false}>
            {path.map((folder, index) => (
              <Fragment key={folder.id}>
                <BreadcrumbSeparator>
                  <motion.span
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={motionQuick}
                  >
                    <ChevronRight className="size-3.5" aria-hidden />
                  </motion.span>
                </BreadcrumbSeparator>
                <BreadcrumbItem>
                  <motion.span
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    transition={motionQuick}
                  >
                    {index === path.length - 1 ? (
                      <BreadcrumbPage className="max-w-48 truncate font-medium">{folder.name}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <button
                          type="button"
                          className="max-w-48 truncate hover:text-foreground transition-colors"
                          onClick={() => onNavigate(folder.id)}
                        >
                          {folder.name}
                        </button>
                      </BreadcrumbLink>
                    )}
                  </motion.span>
                </BreadcrumbItem>
              </Fragment>
            ))}
          </AnimatePresence>
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
  /** Most recent child's timestamp — the "last change" for this folder, like file cards show file time. */
  lastModified?: string | null
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
 * A folder as a grid tile — visually DISTINCT from {@link FileCard}.
 *
 * File cards show a document preview (thumbnail / sketch) above a white body.
 * Folder cards are the opposite: a warm, tinted folder shape that reads as a
 * container you open, not a page you read. The tab + body silhouette, the amber
 * wash, and the stacked-paper hint inside all say "this holds things" before
 * the label does. Hover lifts the folder and nudges the icon from closed →
 * open, reinforcing the affordance without needing a tooltip.
 */
export function FolderCard({
  folder,
  itemCount,
  lastModified,
  onOpen,
  onRenameFolder,
  onDeleteFolder,
}: FolderTileProps): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [editing, setEditing] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  return (
    <GridTileShell variant="file" interactive className="group" data-testid={`folder-card-${folder.id}`}>
      <div
        className="absolute right-1.5 top-1.5 z-[1] md:opacity-0 md:group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 motion-reduce:transition-none"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <FolderActionsMenu folder={folder} onStartRename={() => setEditing(true)} onDeleteFolder={onDeleteFolder} />
      </div>
      <button
        type="button"
        onClick={() => onOpen(folder.id)}
        aria-label={t('folders.openFolder', { name: folder.name })}
        className="flex h-full w-full flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <GridTileBody className="flex-1 p-0">
          <GridTileMedia className="flex h-[124px] items-center justify-center bg-muted/30">
            <motion.div animate={{ scale: isHovered ? 1.06 : 1 }} transition={motionQuick}>
              {isHovered ? (
                <FolderOpen className="size-10 text-muted-foreground/70" strokeWidth={1.4} aria-hidden />
              ) : (
                <Folder className="size-10 text-muted-foreground/60" strokeWidth={1.4} aria-hidden />
              )}
            </motion.div>
          </GridTileMedia>
          <div className="px-3.5 pb-3 pt-[11px]">
            {editing ? (
              <FolderNameEditor folder={folder} onRenameFolder={onRenameFolder} onDone={() => setEditing(false)} />
            ) : (
              <p className="truncate text-sm font-medium leading-tight text-foreground" title={folder.name}>
                {folder.name}
              </p>
            )}
          </div>
        </GridTileBody>
        <GridTileFooter className="gap-1.5 px-3.5 pb-2.5 pt-[9px] text-xs text-muted-foreground/80">
          <span className="shrink-0 tabular-nums">{t('folders.items', { count: String(itemCount) })}</span>
          {lastModified && (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <TimeAgo date={lastModified} locale={locale} className="shrink-0 tabular-nums" />
            </>
          )}
          <span className="flex-1" />
        </GridTileFooter>
      </button>
    </GridTileShell>
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
  lastModified,
  onOpen,
  onRenameFolder,
  onDeleteFolder,
}: FolderTileProps): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-2 px-2 py-1"
      >
        <FolderNameEditor
          folder={folder}
          onRenameFolder={onRenameFolder}
          onDone={() => setEditing(false)}
          className="max-w-96 flex-1"
        />
      </motion.div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={motionQuick}
      className={cn(
        'group flex w-full items-center gap-2 rounded-lg border border-amber-200/40 bg-amber-50/40 px-3 py-2 text-sm dark:bg-amber-950/10 dark:border-amber-800/20',
        'hover:bg-amber-50 hover:border-amber-200/60 dark:hover:bg-amber-950/20 transition-[background-color,border-color,box-shadow] duration-200 ease-out hover:shadow-sm',
      )}
      data-testid={`folder-row-${folder.id}`}
    >
      <button
        type="button"
        onClick={() => onOpen(folder.id)}
        aria-label={t('folders.openFolder', { name: folder.name })}
        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-amber-100 dark:bg-amber-900/30">
          <Folder className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
        </span>
        <span className="text-foreground truncate font-medium">{folder.name}</span>
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
          {itemCount}
        </span>
        {lastModified && (
          <>
            <span aria-hidden className="text-muted-foreground/40 text-xs">
              ·
            </span>
            <TimeAgo date={lastModified} locale={locale} className="shrink-0 text-xs tabular-nums text-muted-foreground" />
          </>
        )}
      </button>
      <FolderActionsMenu
        folder={folder}
        onStartRename={() => setEditing(true)}
        onDeleteFolder={onDeleteFolder}
      />
      <ChevronRight className="size-3.5 shrink-0 text-amber-400/60 group-hover:text-amber-500 transition-colors" aria-hidden />
    </motion.div>
  )
}
