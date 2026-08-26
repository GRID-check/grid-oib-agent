'use client'

import { useMemo, type ReactNode } from 'react'
import type { FileItem, FolderItem } from './project-file-workspace'
import { Search, SearchX, FolderOpen, Sparkles, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileSearch } from '../hooks/use-file-search'
import { FileCard } from './file-card'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { FileListSkeleton, FileListView } from './file-list-view'
import { FilterChip } from './filter-chip'
import { AssignmentFaces } from './assignment-faces'

interface FileBrowserPaneProps {
  files: FileItem[]
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
   * Top-level folders presented as a quick-filter chip row above the grid
   * (mirrors the sidebar tree — same selection state, no separate data model).
   * Omitted by callers without folders (Archiv).
   */
  folders?: FolderItem[]
  selectedFolderId?: string | null
  onSelectFolder?: (id: string | null) => void
  /**
   * The query and semantic mode, owned by the caller — see {@link FileSearch}.
   * The pane filters and renders results; it does not draw the field, because
   * on the Files page the field lives in the page header, one component above
   * this one.
   */
  search: FileSearch
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
  selectedFileId,
  onSelectFile,
  isLoading,
  hasFolderSelected,
  uploadControl,
  uploadCard,
  folders,
  selectedFolderId = null,
  onSelectFolder,
  search,
  view = 'cards',
  showAssignment = false,
  renderActions,
}: FileBrowserPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const { query, semantic } = search

  // Client-side filter over the current listing: name, plus AI tags and
  // summary when the backend generated them.
  const filteredFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return files
    // Both names, deliberately: somebody who renamed a document looks for what
    // they called it, and somebody who uploaded it looks for the file they sent.
    return files.filter(
      (f) =>
        documentDisplayName(f).toLowerCase().includes(q) ||
        f.filename.toLowerCase().includes(q) ||
        (f.summary ?? '').toLowerCase().includes(q) ||
        (f.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
    )
  }, [files, query])

  const topLevelFolders = useMemo(
    () => (folders ?? []).filter((f) => f.parentId === null),
    [folders]
  )

  if (isLoading) {
    // Same rule as the search skeleton below: placeholders take the shape of the
    // view the reader chose, so the first paint is not a layout that was never
    // going to be there.
    return view === 'list' ? (
      <div className="space-y-3 p-4">
        <Skeleton className="h-9 w-full" />
        <FileListSkeleton />
      </div>
    ) : (
      <div className="space-y-3 p-4">
        <Skeleton className="h-9 w-full" />
        <FileGrid>
          {Array.from({ length: 6 }).map((_, i) => (
            <FileCardSkeleton key={i} />
          ))}
        </FileGrid>
      </div>
    )
  }

  // First-run empty state — the whole corpus (or selected folder) has no files.
  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
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
    <div className="flex h-full flex-col">
      {/* No banner over the results. It restated in a tinted strip what the
          listing below it already shows — how many hits, for which query —
          and it moved the whole listing down a row the moment a search ran.
          Everything it carried has a better home: the skeletons say a search
          is running, the empty and failed panels say what came back, and the
          field's own ✕ is the way out. The Archiv's band still uses
          {@link FileSearchBanner}; Files does not. */}

      {/* Top-level folder quick filter — chip presentation of the same folder
          selection the sidebar tree drives (no separate navigation model).
          Hidden in semantic mode (the query is the context). */}
      {!semantic.active && onSelectFolder && topLevelFolders.length > 0 && (
        <div
          // Wrap on mobile so the last folder pill is never clipped at the
          // right edge; keep a single scrollable row from md up (where it fits).
          //
          // `shrink-0` is what keeps the pills READABLE. This row is a flex item
          // of a column that is `h-full` — one viewport tall — while the grid
          // below it is as tall as the corpus, so the column runs a negative free
          // space the moment the listing scrolls. Every other child refuses to
          // absorb it (an item whose overflow is visible cannot shrink below its
          // content), but `overflow-x-auto` drops this one's automatic minimum
          // size to zero, so the whole deficit landed here: the row collapsed to
          // its padding and clipped the pills through the middle of their labels.
          className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2 md:flex-nowrap md:overflow-x-auto"
          role="group"
          aria-label={t('folders.heading')}
        >
          <FilterChip
            label={t('folders.allFiles')}
            active={selectedFolderId === null}
            onClick={() => onSelectFolder(null)}
          />
          {topLevelFolders.map((folder) => (
            <FilterChip
              key={folder.id}
              label={folder.name}
              active={selectedFolderId === folder.id}
              onClick={() => onSelectFolder(folder.id)}
            />
          ))}
        </div>
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
            <div className="p-4">
              <FileGrid>
                {Array.from({ length: 6 }).map((_, i) => (
                  <FileCardSkeleton key={i} />
                ))}
              </FileGrid>
            </div>
          )
        ) : semantic.error ? (
          // A SEARCH THAT NEVER RAN IS NOT A SEARCH THAT FOUND NOTHING.
          // The hook fails open to an empty result set so this pane cannot
          // crash, and it reports which of the two happened — but nothing read
          // that flag, so a backend timeout rendered as "Keine semantischen
          // Treffer für 'Brandschutz'". The surface told the reader their own
          // corpus does not contain what they were looking for, and offered
          // them a reset for it.
          <div className="p-8">
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
                  <Button size="sm" onClick={search.run}>
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
          <div className="p-8">
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
          <div className="p-4">
            <FileGrid>
              {semantic.hits.map((hit) => (
                <FileCard
                  key={hit.id}
                  file={hit}
                  isSelected={selectedFileId === hit.id}
                  onSelect={() => onSelectFile(selectedFileId === hit.id ? null : hit.id)}
                  locale={locale}
                  match={{ snippet: hit.snippet, page: hit.page, score: hit.score }}
                  footerLead={showAssignment ? <AssignmentFaces assignees={hit.assignees} /> : undefined}
                  actions={renderActions?.(hit)}
                />
              ))}
            </FileGrid>
          </div>
        )
      ) : /* Substring-filtered card grid (instant, as you type). */
      filteredFiles.length === 0 ? (
        <div className="p-8">
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
      ) : (
        view === 'list' ? (
          <FileListView
            files={filteredFiles}
            selectedFileId={selectedFileId}
            onSelectFile={(id) => onSelectFile(selectedFileId === id ? null : id)}
            renderActions={renderActions}
          />
        ) : (
          <div className="p-4">
            {/* Section label — "Recently uploaded" at the corpus root, matching
                the click-dummy. Hidden inside a folder view (the chip already
                names it) and while searching (the query is the context). */}
            {query === '' && selectedFolderId === null && (
              <SectionLabel as="p" className="mb-3 font-semibold tracking-[0.05em]">
                {t('browser.recentlyUploaded')}
              </SectionLabel>
            )}
            <FileGrid>
              {filteredFiles.map((file) => (
                <FileCard
                  key={file.id}
                  file={file}
                  isSelected={selectedFileId === file.id}
                  onSelect={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
                  locale={locale}
                  footerLead={showAssignment ? <AssignmentFaces assignees={file.assignees} /> : undefined}
                  actions={renderActions?.(file)}
                />
              ))}
              {uploadCard}
            </FileGrid>
          </div>
        )
      )}
    </div>
  )
}
