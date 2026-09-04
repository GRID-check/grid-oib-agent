'use client'

import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'

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
import { CountPill } from '@/components/ui/count-pill'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { AnimatePresence, motion, motionQuick } from '@/components/motion'
import { BackControl } from '@/components/shell/back-link'
import { useTranslations } from '@/i18n'
import { useLocale } from '@/i18n'
import { folderDragProps, useFolderDropTarget } from '../hooks/use-document-drag'
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
  onDropDocument,
  onDropFolder,
  canAcceptFolder,
}: Pick<FolderNavProps, 'folders' | 'currentFolderId' | 'onNavigate' | 'onCreateFolder'> & {
  children?: ReactNode
  /** Dropping a document on „Alle Dateien" moves it back to the project root. */
  onDropDocument?: (documentId: string, folderId: string | null) => void
  /**
   * Dropping a FOLDER there moves it out to the project root.
   *
   * This is the only way OUT. Every other target nests one folder inside
   * another, so without it a folder could be dragged deeper and never back —
   * the same half-a-gesture the document drag shipped with before the root
   * became a target for it.
   */
  onDropFolder?: (draggedFolderId: string, parentId: string | null) => void
  canAcceptFolder?: (draggedFolderId: string, targetFolderId: string | null) => boolean
}): JSX.Element {
  const t = useTranslations('files')
  const path = useMemo(() => folderPath(folders, currentFolderId), [folders, currentFolderId])
  // The way OUT of a folder. Without it a file could be dragged deeper and
  // never back, and the menu would be the only route for half the gesture.
  const rootDrop = useFolderDropTarget({
    folderId: null,
    onDropDocument: onDropDocument ?? (() => {}),
    onDropFolder,
    canAcceptFolder,
    // Only offered while there is somewhere to come back FROM. At the root the
    // segment is a label, not a link, and it has nothing to receive.
    disabled: (!onDropDocument && !onDropFolder) || currentFolderId === null,
  })

  /**
   * Where "up one level" goes: the parent folder, or the root.
   *
   * Null at the root, where there is nothing to go up to.
   */
  const parent = currentFolderId === null ? undefined : path[path.length - 2]
  const parentLabel = parent ? parent.name : t('folders.allFiles')

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card/50 px-4 py-2.5 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2">
        {/*
          Up one level, as its own control rather than as a breadcrumb segment.

          The breadcrumb says where you ARE — it is a map, and reading a map to
          find the way out is work. Three levels deep the parent is a truncated
          word in the middle of a scrolling row, which is a 90px target for the
          single most common thing anyone does in a folder. Named, so it says
          what it will do before it is pressed.

          The same control the org-wide pages use to leave, deliberately: going
          up a level and leaving a page are one idea, and drawing them twice is
          how two lookalikes drift on the first token retune.
        */}
        {currentFolderId !== null && (
          <BackControl
            label={t('folders.backTo', { name: parentLabel })}
            onClick={() => onNavigate(parent?.id ?? null)}
            className="shrink-0 pr-3"
            testId="folder-back"
          />
        )}
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
                  className={cn(
                    'hover:text-foreground transition-colors rounded px-1',
                    rootDrop.isOver && 'ring-ring bg-accent ring-2'
                  )}
                  data-drop-over={rootDrop.isOver ? '' : undefined}
                  {...rootDrop.dropProps}
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
      </div>
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
  /**
   * Move a document into this folder, when the surface supports dragging one
   * here. Absent on surfaces that do not (the Archiv has no folders at all).
   */
  onDropDocument?: (documentId: string, folderId: string | null) => void
  /**
   * Re-parent another folder into this one. Absent turns the folder drag OFF
   * for this tile in both directions: a tile that lifts under the finger where
   * nothing can receive it promises a move the surface cannot make.
   */
  onDropFolder?: (draggedFolderId: string, parentId: string | null) => void
  /** Whether this tile may receive that folder — see `useFolderDropTarget`. */
  canAcceptFolder?: (draggedFolderId: string, targetFolderId: string | null) => boolean
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
 * A file card shows the document itself: a page preview, a thumbnail, or the
 * kind sketch we draw when there is neither. A folder card shows a folder
 * filling that same well, and the difference between "a page" and "a container"
 * is the whole distinction. It used to be carried by a warm amber wash as well;
 * that wash was invisible at its own opacity in the grid and read as a warning
 * strip in the detail view, and gold is a provenance signal in this product
 * (see `grid-tile.tsx` for the argument). What is left is the thing that was
 * doing the work.
 *
 * Hover lifts the tile — the shell's own `whileHover`, and the one motion this
 * gesture gets. The glyph used to open on hover as well; see the comment on the
 * well below for why a mouse-only flourish is not one this product keeps.
 */
export function FolderCard({
  folder,
  itemCount,
  lastModified,
  onOpen,
  onRenameFolder,
  onDeleteFolder,
  onDropDocument,
  onDropFolder,
  canAcceptFolder,
}: FolderTileProps): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [editing, setEditing] = useState(false)
  const drop = useFolderDropTarget({
    folderId: folder.id,
    onDropDocument: onDropDocument ?? (() => {}),
    onDropFolder,
    canAcceptFolder,
    disabled: !onDropDocument && !onDropFolder,
  })

  return (
    <GridTileShell
      interactive
      // A drag has to say where it will land, or it is a guess with a cursor.
      className={cn('group', drop.isOver && 'ring-ring bg-accent ring-2')}
      data-testid={`folder-card-${folder.id}`}
      data-drop-over={drop.isOver ? '' : undefined}
      // Source as well as target: a folder is moved by dragging it onto
      // another, which is the same gesture that moves a document.
      {...(onDropFolder ? folderDragProps(folder.id) : {})}
      {...drop.dropProps}
    >
      <div
        className="absolute right-1.5 top-1.5 z-[1] md:opacity-0 md:group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-quick ease-out motion-reduce:transition-none"
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
      >
        <GridTileBody className="flex-1 p-0">
          <GridTileMedia className="flex h-[124px] items-center justify-center bg-muted/30">
            {/*
              ONE GLYPH, AND NO SECOND MOTION FOR ONE GESTURE.

              This used to swap `Folder` for `FolderOpen` on hover, driven by
              `useState` through `onMouseEnter`/`onMouseLeave` — a render per
              pointer crossing on every tile in the grid, and a hard cut in the
              middle of a scale, so what a person saw was a flicker rather than
              a folder opening.

              Rebuilding it as a CSS cross-fade fixed the flicker and the
              renders and left the real problem: it was an affordance only a
              MOUSE could reach. `mobile-affordances.spec.ts` says so by name —
              an `opacity-0` revealed by `group-hover` alone, on a device that
              generates no hover — and the escapes it offers do not apply,
              because showing both stacked glyphs on a phone is not the answer.

              So the swap is gone. What says "this opens" is what already said
              it on every input: the tile lifts under the pointer (the shell's
              own `whileHover`), the cursor changes, and the label reads as a
              folder because a folder is drawn in the well.
            */}
            <Folder className="size-10 text-muted-foreground/60" strokeWidth={1.4} aria-hidden />
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
  onDropDocument,
  onDropFolder,
  canAcceptFolder,
}: FolderTileProps): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [editing, setEditing] = useState(false)
  const drop = useFolderDropTarget({
    folderId: folder.id,
    onDropDocument: onDropDocument ?? (() => {}),
    onDropFolder,
    canAcceptFolder,
    disabled: !onDropDocument && !onDropFolder,
  })

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

  /*
   * THE ROW THAT WAS YELLOW.
   *
   * It was `bg-amber-50/40` with an amber icon well, an amber count pill and an
   * amber chevron — three tinted bands across the full width of a listing,
   * stacked above a neutral table. Two things were wrong with it, and the
   * second is the one that made it read as a warning:
   *
   *   1. Chroma in this product is the source-signal system and nothing else
   *      (`grid-design-language.md`). A folder is not a provenance.
   *   2. That gold IS a signal, and it is in the same table: `--source-office`
   *      is the tint on the `JPG` and `PNG` extension chips two rows below. One
   *      hue, two unrelated meanings, one screen.
   *
   * So the row is built out of the neutral ramp, like every other list
   * affordance, and what says "folder" is the glyph and the chevron — shape and
   * contrast, which is what the design language reaches for instead of colour.
   *
   * It also no longer animates itself in. It is rendered inside the level's own
   * keyed transition, so the row slid −6px while its container slid +16px: two
   * motions for one navigation, compounding into a wobble. The level owns the
   * entrance; a row inside it is just content.
   */
  return (
    <div
      className={cn(
        'group border-border bg-muted/40 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm',
        'hover:bg-accent transition-[background-color,box-shadow] duration-quick ease-out hover:shadow-sm motion-reduce:transition-none',
        drop.isOver && 'ring-ring bg-accent ring-2',
      )}
      data-testid={`folder-row-${folder.id}`}
      data-drop-over={drop.isOver ? '' : undefined}
      {...(onDropFolder ? folderDragProps(folder.id) : {})}
      {...drop.dropProps}
    >
      <button
        type="button"
        onClick={() => onOpen(folder.id)}
        aria-label={t('folders.openFolder', { name: folder.name })}
        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
      >
        {/* One glyph, for the reason the card's comment gives. The row's own
            background change is the hover feedback, and a finger gets it too. */}
        <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
          <Folder className="text-muted-foreground size-3.5" aria-hidden />
        </span>
        <span className="text-foreground truncate font-medium">{folder.name}</span>
        {/* The kit's numeric pill, not a fourth hand-rolled one. */}
        <CountPill>{itemCount}</CountPill>
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
      <ChevronRight
        className="text-muted-foreground/40 group-hover:text-muted-foreground size-3.5 shrink-0 transition-colors duration-quick ease-out motion-reduce:transition-none"
        aria-hidden
      />
    </div>
  )
}

/**
 * The three folder placeholders, kept in this file on purpose.
 *
 * A skeleton is a promise about the layout that is one frame away, and the only
 * way it keeps that promise is by being edited in the same breath as the thing
 * it stands for. The Files skeleton drifted precisely because it lived
 * somewhere else: it drew a full-width search bar the page had moved into its
 * header a release earlier, and no folder tiles at all, so the first paint
 * showed a shape that was never going to arrive.
 *
 * Each one reuses the REAL wrapper — the same shell, the same row chrome, the
 * same padding — so a change to the tile moves its placeholder with it and only
 * the ink inside is grey.
 */

/** A {@link FolderCard} before its name arrives. */
export function FolderCardSkeleton(): JSX.Element {
  return (
    <GridTileShell interactive={false} data-testid="folder-card-skeleton">
      <GridTileBody className="flex-1 p-0">
        <GridTileMedia className="flex h-[124px] items-center justify-center bg-muted/30">
          <Folder className="size-10 text-muted-foreground/25" strokeWidth={1.4} aria-hidden />
        </GridTileMedia>
        <div className="px-3.5 pb-3 pt-[11px]">
          <Skeleton className="h-4 w-24" />
        </div>
      </GridTileBody>
      <GridTileFooter className="gap-1.5 px-3.5 pb-2.5 pt-[9px]">
        <Skeleton className="h-3 w-12" />
      </GridTileFooter>
    </GridTileShell>
  )
}

/** A {@link FolderRow} before its name arrives. */
export function FolderRowSkeleton(): JSX.Element {
  return (
    <div
      className="border-border bg-muted/40 flex w-full items-center gap-2 rounded-lg border px-3 py-2"
      data-testid="folder-row-skeleton"
    >
      <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
        <Folder className="text-muted-foreground/40 size-3.5" aria-hidden />
      </span>
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="h-3.5 w-8 rounded-full" />
    </div>
  )
}

/**
 * The path row before the tree is known.
 *
 * The same chrome as {@link FolderBreadcrumbRow} — border, tint, height — so
 * the listing below it does not shift down by a row when the real one replaces
 * it. „Alle Dateien" is drawn rather than greyed out: it is the one segment
 * that is true before anything has loaded, at every level, and a reader who
 * lands mid-load should see where they are rather than a grey pill where the
 * word will be.
 */
export function FolderBreadcrumbRowSkeleton(): JSX.Element {
  const t = useTranslations('files')
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-2 border-b bg-card/50 px-4 py-2.5 backdrop-blur-sm"
      data-testid="folder-breadcrumb-skeleton"
    >
      <span className="text-sm font-medium text-muted-foreground">{t('folders.allFiles')}</span>
      <Skeleton className="h-8 w-28 rounded-md" />
    </div>
  )
}
