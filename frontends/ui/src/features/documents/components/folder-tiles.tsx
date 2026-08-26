'use client'

import { Fragment, useState, type ReactNode } from 'react'
import { Folder, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { FileItem, FolderItem } from './project-file-workspace'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { countDocumentsInFolder, folderTrail } from '../folder-counts'
import { FILE_GRID_TEMPLATE } from './file-card-size'

/**
 * The tile shell, shared by a folder, a folder being renamed, and the
 * new-folder tile — so the three are the same box and the shelf never jumps as
 * one of them turns into another.
 */
const TILE_CLASS =
  'flex min-w-0 items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-shadow duration-quick ease-out motion-reduce:transition-none'

const TILE_RESTING = 'border-border bg-card shadow-xs border hover:shadow-md'

/**
 * The per-tile ⋯ trigger. Hidden until the tile is hovered or the control
 * itself is focused, and ALWAYS present on a coarse pointer, where there is no
 * hover to reveal it with. The same rule the folder rows carried before they
 * were tiles.
 */
const TILE_ACTION_CLASS =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-snap ease-out hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11 motion-reduce:transition-none md:opacity-0 md:group-hover/tile:opacity-100 data-[state=open]:opacity-100'

/** The square that carries the glyph, on all three tiles. */
function FolderGlyph({ children }: { children?: ReactNode }) {
  return (
    <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-xl">
      {children ?? <Folder className="size-[18px]" aria-hidden />}
    </span>
  )
}

/**
 * One folder, as an object you can see, open and act on.
 *
 * Deliberately NOT the raised {@link FileCard} anatomy: a folder is a container,
 * a document is a thing, and giving them the same two-surface card would leave
 * the reader sorting them out by their labels. A folder gets the design
 * language's plain form — one border over `bg-card` — at a fraction of the
 * height, so a row of them reads as a shelf above the documents rather than as
 * a first row of files.
 */
function FolderTile({
  folder,
  count,
  onOpen,
  onRename,
  onDelete,
}: {
  folder: FolderItem
  count: number
  onOpen: () => void
  onRename?: () => void
  onDelete?: () => void
}) {
  const t = useTranslations('files')
  return (
    <div className={cn('group/tile relative', TILE_CLASS, TILE_RESTING)}>
      <button
        type="button"
        onClick={onOpen}
        data-testid="folder-tile"
        data-folder-id={folder.id}
        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2"
      >
        <FolderGlyph />
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium" title={folder.name}>
            {folder.name}
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs tabular-nums">
            {t('folders.count', { count: String(count) })}
          </span>
        </span>
      </button>
      {(onRename || onDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('folders.actionsFor', { name: folder.name })}
              title={t('folders.actions')}
              className={TILE_ACTION_CLASS}
              data-testid={`folder-actions-${folder.id}`}
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {onRename && (
              <DropdownMenuItem onSelect={onRename}>
                <Pencil className="size-4" aria-hidden />
                {t('folders.rename')}
              </DropdownMenuItem>
            )}
            {onDelete && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={onDelete}
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
  )
}

/**
 * A folder name being typed, in the tile it belongs to.
 *
 * In place, not in a dialog: the reader is looking at the name they want to
 * change, and a modal would take it off screen to ask about it. Same box, same
 * cell, same width as the tile it stands in for. A rejected name leaves the
 * field open with the typed text intact — nobody should have to type a name
 * twice because the server was busy.
 */
function FolderNameTile({
  initialValue,
  label,
  placeholder,
  busyLabel,
  testId,
  onCommit,
  onCancel,
}: {
  initialValue: string
  label: string
  placeholder: string
  busyLabel: string
  testId: string
  /** Resolves false when the name was rejected; the field then stays open. */
  onCommit: (name: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const [isBusy, setIsBusy] = useState(false)

  const commit = async () => {
    const name = value.trim()
    if (!name || isBusy) return
    // The same name is a cancel, not a request: Enter on an untouched field
    // should not be a round trip.
    if (name === initialValue) {
      onCancel()
      return
    }
    setIsBusy(true)
    const ok = await onCommit(name)
    setIsBusy(false)
    if (ok) onCancel()
  }

  return (
    <div className={cn(TILE_CLASS, TILE_RESTING)}>
      <FolderGlyph />
      <InputGroup className="h-9 min-w-0 flex-1">
        <Input
          autoFocus
          value={value}
          disabled={isBusy}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            if (isBusy) return
            if (value.trim()) void commit()
            else onCancel()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commit()
            if (event.key === 'Escape') onCancel()
          }}
          aria-label={label}
          aria-busy={isBusy}
          placeholder={placeholder}
          className="h-9 rounded-md pr-8 text-sm"
          data-testid={testId}
        />
        {isBusy && (
          <InputGroupAddon align="end">
            <Spinner size="sm" label={busyLabel} />
          </InputGroupAddon>
        )}
      </InputGroup>
    </div>
  )
}

export interface FolderTilesProps {
  folders: FolderItem[]
  files: FileItem[]
  /** Whose children to show — `null` is the project root. */
  parentId: string | null
  onOpenFolder: (id: string) => void
  /**
   * Folder management, when the reader may do it.
   *
   * This is where it lives now. It used to live only in the sidebar tree, so
   * retiring that view would have retired creating, renaming and deleting a
   * folder with it — an affordance that exists in no view is an affordance
   * nobody has. Omit the handlers for a read-only shelf.
   */
  onCreateFolder?: (name: string, parentId?: string) => Promise<boolean>
  onRenameFolder?: (folderId: string, name: string) => Promise<boolean>
  onDeleteFolder?: (folderId: string) => Promise<boolean>
}

/**
 * The folders that live directly under `parentId`, as a shelf of tiles above
 * the document grid, with the new-folder tile at its end.
 *
 * This replaced the flat chip row the cards view used to carry. Two things the
 * chips could not do: they showed only TOP-LEVEL folders, so a subfolder was
 * unreachable outside the tree view, and they said nothing about what was
 * inside — a name with no weight behind it.
 */
export function FolderTiles({
  folders,
  files,
  parentId,
  onOpenFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}: FolderTilesProps) {
  const t = useTranslations('files')
  /** The folder whose name is being edited, or `'new'` while one is created. */
  const [editing, setEditing] = useState<string | null>(null)
  const children = folders.filter((folder) => folder.parentId === parentId)

  // Nothing to show and nothing to add: no empty shelf above the grid.
  if (children.length === 0 && !onCreateFolder) return null

  return (
    <div
      className={cn('mb-6 grid items-stretch gap-3 sm:gap-3.5', FILE_GRID_TEMPLATE.roomy)}
      role="group"
      aria-label={t('folders.heading')}
      data-testid="folder-tiles"
    >
      {children.map((folder) =>
        editing === folder.id && onRenameFolder ? (
          <FolderNameTile
            key={folder.id}
            initialValue={folder.name}
            label={t('folders.renameLabel', { name: folder.name })}
            placeholder={t('folders.namePlaceholder')}
            busyLabel={t('folders.renaming')}
            testId={`folder-rename-input-${folder.id}`}
            onCommit={(name) => onRenameFolder(folder.id, name)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <FolderTile
            key={folder.id}
            folder={folder}
            count={countDocumentsInFolder(files, folders, folder.id)}
            onOpen={() => onOpenFolder(folder.id)}
            {...(onRenameFolder ? { onRename: () => setEditing(folder.id) } : {})}
            {...(onDeleteFolder ? { onDelete: () => void onDeleteFolder(folder.id) } : {})}
          />
        )
      )}

      {onCreateFolder &&
        (editing === 'new' ? (
          <FolderNameTile
            initialValue=""
            label={t('folders.newFolderName')}
            placeholder={t('folders.namePlaceholder')}
            busyLabel={t('folders.creating')}
            testId="folder-create-input"
            onCommit={(name) => onCreateFolder(name, parentId ?? undefined)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          // Dashed, so the shelf says at a glance which tiles hold something and
          // which one makes another. A new folder lands at the level the reader
          // is looking at, which is what keeps subfolders creatable now that the
          // per-row "add subfolder" control is gone with the tree.
          <button
            type="button"
            onClick={() => setEditing('new')}
            data-testid="folder-create-tile"
            className={cn(
              TILE_CLASS,
              'border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground focus-visible:ring-ring border border-dashed focus-visible:outline-none focus-visible:ring-2'
            )}
          >
            <FolderGlyph>
              <Plus className="size-[18px]" aria-hidden />
            </FolderGlyph>
            <span className="truncate text-sm font-medium">{t('folders.newFolder')}</span>
          </button>
        ))}
    </div>
  )
}

/**
 * Where in the folder tree the listing currently is, and the way back out.
 *
 * The chip row used to be the way back — every level was one click from the
 * root because every chip was always on screen. Tiles drill DOWN, so without
 * this a subfolder would be a dead end. Absent at the root, where there is
 * nothing to climb.
 *
 * Plain buttons rather than the breadcrumb primitive: this is not the page's
 * position in the app, which is what a breadcrumb states and what the rail
 * already answers. It is the listing's position inside one project's folders,
 * it changes without navigating, and every step is a control rather than a link.
 */
export function FolderTrail({
  folders,
  selectedFolderId,
  onSelectFolder,
}: {
  folders: FolderItem[]
  selectedFolderId: string | null
  onSelectFolder: (id: string | null) => void
}) {
  const t = useTranslations('files')
  const trail = folderTrail(folders, selectedFolderId)
  if (trail.length === 0) return null

  const linkClass =
    'hover:text-foreground truncate rounded-sm transition-colors duration-snap ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'

  return (
    <nav
      aria-label={t('folders.heading')}
      className="text-muted-foreground mb-4 flex min-w-0 items-center gap-1.5 text-sm"
      data-testid="folder-trail"
    >
      <button type="button" onClick={() => onSelectFolder(null)} className={linkClass}>
        {t('folders.allFiles')}
      </button>
      {trail.map((folder, index) => {
        const isCurrent = index === trail.length - 1
        return (
          <Fragment key={folder.id}>
            <span aria-hidden className="text-muted-foreground/50">
              /
            </span>
            {isCurrent ? (
              <span aria-current="page" className="text-foreground truncate font-medium">
                {folder.name}
              </span>
            ) : (
              <button type="button" onClick={() => onSelectFolder(folder.id)} className={linkClass}>
                {folder.name}
              </button>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
