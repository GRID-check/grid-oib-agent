'use client'

import { Fragment } from 'react'
import { Folder } from 'lucide-react'
import type { FileItem, FolderItem } from './project-file-workspace'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { countDocumentsInFolder, folderTrail } from '../folder-counts'
import { FILE_GRID_TEMPLATE } from './file-card-size'

/**
 * One folder, as an object you can see and open.
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
}: {
  folder: FolderItem
  count: number
  onOpen: () => void
}) {
  const t = useTranslations('files')
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="folder-tile"
      data-folder-id={folder.id}
      className="border-border bg-card shadow-xs duration-quick focus-visible:ring-ring flex min-w-0 items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-shadow ease-out hover:shadow-md focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
    >
      <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-xl">
        <Folder className="size-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium" title={folder.name}>
          {folder.name}
        </span>
        <span className="text-muted-foreground mt-0.5 block text-xs tabular-nums">
          {t('folders.count', { count: String(count) })}
        </span>
      </span>
    </button>
  )
}

/**
 * The folders that live directly under `parentId`, as a row of tiles above the
 * document grid.
 *
 * This replaces the flat chip row the cards view used to carry. Two things the
 * chips could not do: they showed only TOP-LEVEL folders, so a subfolder was
 * simply unreachable outside the tree view, and they said nothing about what was
 * inside — a name with no weight behind it. Renders nothing when the level has
 * no folders, so an unfoldered project keeps its grid at the top of the column.
 */
export function FolderTiles({
  folders,
  files,
  parentId,
  onOpenFolder,
}: {
  folders: FolderItem[]
  files: FileItem[]
  /** Whose children to show — `null` is the project root. */
  parentId: string | null
  onOpenFolder: (id: string) => void
}) {
  const t = useTranslations('files')
  const children = folders.filter((folder) => folder.parentId === parentId)
  if (children.length === 0) return null

  return (
    <div
      className={cn('mb-6 grid items-stretch gap-3 sm:gap-3.5', FILE_GRID_TEMPLATE.roomy)}
      role="group"
      aria-label={t('folders.heading')}
      data-testid="folder-tiles"
    >
      {children.map((folder) => (
        <FolderTile
          key={folder.id}
          folder={folder}
          count={countDocumentsInFolder(files, folders, folder.id)}
          onOpen={() => onOpenFolder(folder.id)}
        />
      ))}
    </div>
  )
}

/**
 * Where in the folder tree the listing currently is, and the way back out.
 *
 * The chip row used to be the way back — every level was one click from the
 * root because every chip was always on screen. Tiles drill DOWN, so without
 * this a subfolder would be a dead end for anyone not using the tree view.
 * Absent at the root, where there is nothing to climb.
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

  return (
    <Breadcrumb className="mb-4" data-testid="folder-trail">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <button type="button" onClick={() => onSelectFolder(null)}>
              {t('folders.allFiles')}
            </button>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {trail.map((folder, index) => {
          const isCurrent = index === trail.length - 1
          return (
            <Fragment key={folder.id}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {isCurrent ? (
                  <BreadcrumbPage>{folder.name}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button type="button" onClick={() => onSelectFolder(folder.id)}>
                      {folder.name}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
