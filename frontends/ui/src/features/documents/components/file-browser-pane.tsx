'use client'

import { type ReactNode } from 'react'
import type { FileItem, FolderItem } from './project-file-workspace'
import { Search, SearchX, FolderOpen, Sparkles, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FileSearchState } from '../hooks/use-file-search'
import { FileCard } from './file-card'
import { FILE_GRID_TEMPLATE } from './file-card-size'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { FileListSkeleton, FileListView } from './file-list-view'
import { FolderTiles, FolderTrail } from './folder-tiles'
import { AssignmentFaces } from './assignment-faces'

interface FileBrowserPaneProps {
  /** The listing to show — already narrowed by folder and assignment filter. */
  files: FileItem[]
  /**
   * The project's WHOLE corpus, unnarrowed. Only the folder tiles read it, and
   * they have to: a tile's count is about what is inside that folder, not about
   * what survived the filter the reader is currently looking through.
   */
  allFiles: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
  /** True when a specific folder is selected (vs. the "All Files" root). */
  hasFolderSelected: boolean
  /** Upload control rendered inside the first-run empty state. */
  uploadControl?: ReactNode
  /** Dashed upload card rendered as the last tile of the grid (project corpus). */
  uploadCard?: ReactNode
  /**
   * The search field, for the narrow window where the page header cannot hold
   * it (below `lg`). Rendered full width at the top of the listing — where it
   * used to live for every window — and hidden from `lg`, when the copy in the
   * header takes over. The two are one control: only ever one is displayed.
   */
  searchField?: ReactNode
  /**
   * The query, the semantic run and the instant filter. Owned by the workspace,
   * because the field itself lives up in the page header — see
   * {@link import('../hooks/use-file-search').useFileSearch}.
   */
  search: FileSearchState
  /**
   * The project's folders, presented as tiles above the grid: the children of
   * the current level, with what each holds. Omitted by callers without folders
   * (Archiv).
   */
  folders?: FolderItem[]
  selectedFolderId?: string | null
  onSelectFolder?: (id: string | null) => void
  /**
   * Create / rename / delete, threaded to the folder tiles. They are the only
   * home folder management has now that the sidebar tree is gone; omit them for
   * a reader who may not manage folders.
   */
  onCreateFolder?: (name: string, parentId?: string) => Promise<boolean>
  onRenameFolder?: (folderId: string, name: string) => Promise<boolean>
  onDeleteFolder?: (folderId: string) => Promise<boolean>
  /** Folders are still on their way; the shelf holds its height meanwhile. */
  isLoadingFolders?: boolean
  /**
   * The folder list could not be loaded. Said out loud rather than rendering an
   * empty shelf: a project whose folders failed to arrive is not a project
   * without folders, and the difference is the reader's whole mental model of
   * where their documents are.
   */
  foldersError?: ReactNode
  /**
   * How the listing renders. `cards` is the browsing surface; `list` is the
   * explorer's sortable detail view for a corpus too large to skim as tiles.
   * Search, folder filtering and selection are identical in both — the view is
   * a presentation choice, never a different data path.
   */
  view?: 'cards' | 'list'
  showAssignment?: boolean
  /** Per-file rename / delete / download — shown on the card and the list row. */
  renderActions?: (file: FileItem) => ReactNode
}

export function FileBrowserPane({
  files,
  allFiles,
  selectedFileId,
  onSelectFile,
  isLoading,
  hasFolderSelected,
  uploadControl,
  uploadCard,
  searchField,
  search,
  folders,
  selectedFolderId = null,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  isLoadingFolders = false,
  foldersError,
  view = 'cards',
  showAssignment = false,
  renderActions,
}: FileBrowserPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const { query, semantic } = search
  const filteredFiles = search.filter(files)

  if (isLoading) {
    // Same rule as the search skeleton below: placeholders take the shape of the
    // view the reader chose, so the first paint is not a layout that was never
    // going to be there.
    return view === 'list' ? (
      <FileListSkeleton />
    ) : (
      <FileGrid size="roomy">
        {Array.from({ length: 6 }).map((_, i) => (
          <FileCardSkeleton key={i} size="roomy" />
        ))}
      </FileGrid>
    )
  }

  // The folder shelf comes before the emptiness check on purpose. A folder whose
  // files all sit one level further down holds no documents of ITS own, and
  // returning the "nothing here" state for it would hide the very subfolders
  // that hold them. The same goes for the new-folder tile: an empty project is
  // exactly where somebody wants to make the first folder.
  const hasFolderPane = onSelectFolder !== undefined && folders !== undefined
  const showsFolderShelf =
    hasFolderPane &&
    (foldersError !== undefined ||
      isLoadingFolders ||
      onCreateFolder !== undefined ||
      (folders ?? []).some((folder) => folder.parentId === selectedFolderId))

  // First-run empty state — this level has neither documents nor a folder shelf.
  if (files.length === 0 && !showsFolderShelf) {
    return (
      <div className="flex items-center justify-center py-16">
        {hasFolderSelected ? (
          <EmptyState
            icon={FolderOpen}
            title={t('browser.folderEmptyTitle')}
            description={t('browser.folderEmptyDescription')}
            action={uploadControl}
          />
        ) : (
          <EmptyState
            icon={UploadCloud}
            title={t('browser.noDocumentsTitle')}
            description={t('browser.noDocumentsDescription')}
            action={uploadControl}
          />
        )}
      </div>
    )
  }

  return (
    <div className="min-w-0">
      {searchField && <div className="mb-4 lg:hidden">{searchField}</div>}

      {/* No banner over the results. It restated in a tinted strip what the
          listing below already shows — how many hits, for which query — and it
          pushed the whole listing down a row the moment a search ran. What it
          carried has better homes: the skeletons say a search is running, the
          empty and failed panels say what came back, and the field's own ✕ is
          the way out. */}

      {/* Where in the tree the listing is, and the way back up. Hidden in
          semantic mode (the query is the context, not the folder). */}
      {!semantic.active && onSelectFolder && folders && (
        <FolderTrail
          folders={folders}
          selectedFolderId={selectedFolderId}
          onSelectFolder={onSelectFolder}
        />
      )}

      {/* The folders at this level, as objects rather than as a filter row —
          and the only place a folder can be made, renamed or deleted. */}
      {!semantic.active && hasFolderPane && foldersError !== undefined ? (
        <div className="mb-6">{foldersError}</div>
      ) : !semantic.active && hasFolderPane && isLoadingFolders ? (
        // Placeholders in the shelf's own shape, so its arrival does not push
        // the whole grid down a row.
        <div
          className={cn('mb-6 grid items-stretch gap-3 sm:gap-3.5', FILE_GRID_TEMPLATE.roomy)}
          aria-busy
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[66px] rounded-xl" />
          ))}
        </div>
      ) : (
        !semantic.active &&
        onSelectFolder &&
        folders && (
          <FolderTiles
            folders={folders}
            files={allFiles}
            parentId={selectedFolderId}
            onOpenFolder={onSelectFolder}
            {...(onCreateFolder ? { onCreateFolder } : {})}
            {...(onRenameFolder ? { onRenameFolder } : {})}
            {...(onDeleteFolder ? { onDeleteFolder } : {})}
          />
        )
      )}

      {semantic.active ? (
        // Semantic results — one card per matched file, each showing the match
        // evidence (snippet + page + relevance). A backend error/timeout fails
        // open to an empty result set (never a crash).
        semantic.isSearching ? (
          // Placeholders shaped like the view the answer will arrive in. Card
          // skeletons were drawn whatever the reader had chosen, so a search
          // from the list flashed a wall of tiles and then snapped to a table.
          view === 'list' ? (
            <FileListSkeleton />
          ) : (
            <FileGrid size="roomy">
              {Array.from({ length: 6 }).map((_, i) => (
                <FileCardSkeleton key={i} size="roomy" />
              ))}
            </FileGrid>
          )
        ) : semantic.error ? (
          // A SEARCH THAT NEVER RAN IS NOT A SEARCH THAT FOUND NOTHING.
          // The hook fails open to an empty result set so this pane cannot
          // crash, and it reports which of the two happened — but nothing read
          // that flag, so a backend timeout rendered as "Keine semantischen
          // Treffer für 'Brandschutz'". The surface told the reader their own
          // corpus does not contain what they were looking for, and offered
          // them a reset for it.
          <div className="py-12">
            <EmptyState
              variant="bare"
              icon={SearchX}
              title={t('browser.semantic.failed')}
              description={t('browser.semantic.failedDescription')}
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {/* Retries the SAME query — offering only "show all files"
                      asks the reader to give up and retype a search they have
                      already made. */}
                  <Button size="sm" onClick={() => semantic.run(query)}>
                    {t('browser.semantic.retry')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={search.clear}>
                    {t('browser.semantic.reset')}
                  </Button>
                </div>
              }
            />
          </div>
        ) : semantic.hits.length === 0 ? (
          <div className="py-12">
            <EmptyState
              variant="bare"
              icon={Sparkles}
              title={t('browser.semantic.noResults', { query: semantic.query ?? '' })}
              description={t('browser.semantic.noResultsDescription')}
              action={
                <Button variant="outline" size="sm" onClick={search.clear}>
                  {t('browser.semantic.reset')}
                </Button>
              }
            />
          </div>
        ) : view === 'list' ? (
          /* The view toggle keeps meaning while searching. It used to be read
             only on the un-searched branch, so a reader who had deliberately
             switched to the detail view was thrown back into cards the moment
             they pressed Enter — and back again when they cleared the query.
             `key` on the query so a new result set starts at the top of its own
             ranking rather than inheriting the last one's sort and tab stop. */
          <FileListView
            key={semantic.query ?? ''}
            semantic
            files={semantic.hits}
            selectedFileId={selectedFileId}
            onSelectFile={(id) => onSelectFile(selectedFileId === id ? null : id)}
            renderActions={renderActions}
          />
        ) : (
          <FileGrid size="roomy">
            {semantic.hits.map((hit) => (
              <FileCard
                key={hit.id}
                file={hit}
                size="roomy"
                isSelected={selectedFileId === hit.id}
                onSelect={() => onSelectFile(selectedFileId === hit.id ? null : hit.id)}
                locale={locale}
                match={{ snippet: hit.snippet, page: hit.page, score: hit.score }}
                footerLead={
                  showAssignment ? <AssignmentFaces assignees={hit.assignees} /> : undefined
                }
                actions={renderActions?.(hit)}
              />
            ))}
          </FileGrid>
        )
      ) : files.length === 0 ? (
        // Nothing filed HERE, but the folders above are the point of the screen.
        <div className="py-10">
          <EmptyState
            variant="bare"
            icon={FolderOpen}
            title={t('browser.folderEmptyTitle')}
            description={t('browser.folderEmptyDescription')}
            action={uploadControl}
          />
        </div>
      ) : /* Substring-filtered card grid (instant, as you type). */
      filteredFiles.length === 0 ? (
        <div className="py-12">
          <EmptyState
            variant="bare"
            icon={Search}
            title={t('browser.noMatch', { query })}
            description={t('browser.noMatchDescription')}
            action={
              <Button variant="outline" size="sm" onClick={search.clear}>
                {t('browser.clearSearch')}
              </Button>
            }
          />
        </div>
      ) : view === 'list' ? (
        <FileListView
          files={filteredFiles}
          selectedFileId={selectedFileId}
          onSelectFile={(id) => onSelectFile(selectedFileId === id ? null : id)}
          renderActions={renderActions}
        />
      ) : (
        <>
          {/* Section label — "Recently uploaded" at the corpus root, matching
              the click-dummy. Hidden inside a folder view (the trail already
              names it) and while searching (the query is the context). */}
          {query === '' && selectedFolderId === null && (
            <SectionLabel as="p" className="mb-3 font-semibold tracking-[0.05em]">
              {t('browser.recentlyUploaded')}
            </SectionLabel>
          )}
          <FileGrid size="roomy">
            {filteredFiles.map((file) => (
              <FileCard
                key={file.id}
                file={file}
                size="roomy"
                isSelected={selectedFileId === file.id}
                onSelect={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
                locale={locale}
                footerLead={
                  showAssignment ? <AssignmentFaces assignees={file.assignees} /> : undefined
                }
                actions={renderActions?.(file)}
              />
            ))}
            {uploadCard}
          </FileGrid>
        </>
      )}
    </div>
  )
}
