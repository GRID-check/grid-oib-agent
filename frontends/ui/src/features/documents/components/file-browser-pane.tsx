'use client'

import { useMemo, useState, type ReactNode } from 'react'
import type { FileItem, FolderItem } from './project-file-workspace'
import { Search, SearchX, FolderOpen, Sparkles, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useLocale, useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import { useSemanticSearch } from '../hooks/use-semantic-search'
import { FileCard } from './file-card'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { FileListSkeleton, FileListView } from './file-list-view'
import { FileSearchBar } from './file-search-bar'
import { FolderBreadcrumbRow, FolderCard, FolderRow } from './folder-navigation'
import { AssignmentFaces } from './assignment-faces'

/** Finder-style drill-down wiring — see `folder-navigation.tsx`. */
export interface FolderNavigation {
  folders: FolderItem[]
  /** The level the reader is standing in; null is the root. */
  currentFolderId: string | null
  onNavigate: (id: string | null) => void
  onCreateFolder: (name: string, parentId?: string) => Promise<boolean>
  onRenameFolder: (folderId: string, name: string) => Promise<boolean>
  onDeleteFolder: (folderId: string) => Promise<boolean>
}

interface FileBrowserPaneProps {
  /** The CURRENT LEVEL's files (the caller applies the folder filter). */
  files: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
  /** Upload control rendered inside the first-run empty state. */
  uploadControl?: ReactNode
  /** Dashed upload card rendered as the last tile of the grid (project corpus). */
  uploadCard?: ReactNode
  /**
   * Folder drill-down: breadcrumb path on top, folder cards/rows beside the
   * files, create/rename/delete in place. Omitted by callers without folders
   * (the Archiv is flat by design, ADR-0024).
   */
  folderNav?: FolderNavigation
  /**
   * The whole corpus (after the caller's other filters), for the type-ahead
   * filter: a search escapes the current folder, so a document two levels down
   * is findable from the root. Defaults to `files`.
   */
  searchFiles?: FileItem[]
  /**
   * Project whose corpus the explicit-run semantic search queries. When
   * provided, pressing Enter (or the search button) runs a deterministic vector
   * search via `/api/documents/search`; the instant substring filter over the
   * current listing keeps working as the user types. Omit to disable semantic
   * mode (the substring filter still works).
   */
  projectId?: string
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
  uploadControl,
  uploadCard,
  folderNav,
  searchFiles,
  projectId,
  view = 'cards',
  showAssignment = false,
  renderActions,
}: FileBrowserPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [search, setSearch] = useState('')

  // A WIDTH question, so it is asked on the width axis (`useIsMobile` is the
  // `md` breakpoint): how many characters of placeholder the field can show is
  // about the viewport, not about what is driving the pointer.
  const isNarrow = useIsMobile()

  const semanticBody = useMemo(() => ({ projectId }), [projectId])
  const semantic = useSemanticSearch({ endpoint: '/api/documents/search', extraBody: semanticBody })
  const canSearch = projectId !== undefined

  // Commit the current query to the semantic search (Enter / search button).
  const runSemantic = () => {
    if (canSearch) semantic.run(search)
  }
  // Any edit to the query drops back to the live substring filter so the two
  // modes never show a stale mix; the reset control does the same explicitly.
  const handleSearchChange = (value: string) => {
    setSearch(value)
    if (semantic.active) semantic.reset()
  }
  const clearSearch = () => {
    setSearch('')
    semantic.reset()
  }

  // Client-side filter: name, plus AI tags and summary when the backend
  // generated them. A typed query escapes the current folder (the query is the
  // context), so it runs over the corpus, not the level.
  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return files
    // Both names, deliberately: somebody who renamed a document looks for what
    // they called it, and somebody who uploaded it looks for the file they sent.
    return (searchFiles ?? files).filter(
      (f) =>
        documentDisplayName(f).toLowerCase().includes(q) ||
        f.filename.toLowerCase().includes(q) ||
        (f.summary ?? '').toLowerCase().includes(q) ||
        (f.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
    )
  }, [files, searchFiles, search])

  const currentFolderId = folderNav?.currentFolderId ?? null

  /** The folders directly inside the current level — the drill-down tiles. */
  const childFolders = useMemo(
    () => (folderNav?.folders ?? []).filter((f) => f.parentId === currentFolderId),
    [folderNav?.folders, currentFolderId]
  )

  /** Documents + subfolders directly inside `folderId`, for the count line. */
  const folderItemCount = (folderId: string): number => {
    const docs = (searchFiles ?? files).filter((f) => (f.folderId ?? null) === folderId).length
    const subs = (folderNav?.folders ?? []).filter((f) => f.parentId === folderId).length
    return docs + subs
  }

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

  // First-run empty state — nothing anywhere: no documents, no folders. An
  // EMPTY FOLDER is not this case; it keeps the breadcrumb so the reader can
  // walk back out or create something where they stand.
  const corpusEmpty = (searchFiles ?? files).length === 0
  if (corpusEmpty && (folderNav?.folders ?? []).length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon={UploadCloud}
          title={t('browser.noDocumentsTitle')}
          description={t('browser.noDocumentsDescription')}
          action={uploadControl}
        />
      </div>
    )
  }

  const searching = search.trim() !== ''
  const levelEmpty = files.length === 0 && childFolders.length === 0

  return (
    <div className="flex h-full flex-col">
      {/* Search bar — instant substring filter as you type; Enter (or the search
          button) runs the semantic search over the project corpus. */}
      <FileSearchBar
        value={search}
        onChange={handleSearchChange}
        onSubmit={runSemantic}
        onClear={clearSearch}
        // The long placeholder TEACHES ("press Enter for semantic search"), and a
        // lesson that gets cut off at "Search files — pres" teaches nothing while
        // still costing the field its whole width. Below the breakpoint it is the
        // plain one, because on a phone the lesson has already been given twice
        // over: the field carries `enterKeyHint="search"`, so the keyboard's own
        // action key reads "Search", and the run button sits right beside it.
        placeholder={
          canSearch && !isNarrow
            ? t('browser.semantic.searchPlaceholder')
            : t('browser.searchPlaceholder')
        }
        searchLabel={t('browser.searchLabel')}
        resetLabel={t('browser.resetSearch')}
        canSearch={canSearch}
        runLabel={t('browser.semantic.run')}
        isSearching={semantic.isSearching}
        semanticActive={semantic.active}
        bannerText={
          semantic.isSearching
            ? t('browser.semantic.searching', { query: semantic.query ?? '' })
            : // The count is a claim about the corpus, and a search that never
              // ran has not counted anything. Reporting "0 results" above a
              // panel that says the search failed is the same lie twice, in the
              // one line the reader takes at face value.
              semantic.error
              ? t('browser.semantic.failedBanner', { query: semantic.query ?? '' })
              : t('browser.semantic.banner', {
                  count: String(semantic.hits.length),
                  query: semantic.query ?? '',
                })
        }
        resetSemanticLabel={t('browser.semantic.reset')}
        onResetSemantic={clearSearch}
        bannerTestId="semantic-banner"
      />

      {/* The path, Finder-style: where the reader stands, every ancestor a
          click back out, and "New folder" for the level they are in. Hidden
          while a query is active in either mode (the query is the context and
          its results span the corpus). */}
      {folderNav && !semantic.active && !searching && (
        <FolderBreadcrumbRow
          folders={folderNav.folders}
          currentFolderId={folderNav.currentFolderId}
          onNavigate={folderNav.onNavigate}
          onCreateFolder={folderNav.onCreateFolder}
        />
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
                  <Button size="sm" onClick={() => semantic.run(search)}>
                    {t('browser.semantic.retry')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={clearSearch}>
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
                <Button variant="outline" size="sm" onClick={clearSearch}>
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
          <div className={CONTENT_MAX}>
            <FileListView
              key={semantic.query ?? ''}
              semantic
              files={semantic.hits}
              selectedFileId={selectedFileId}
              onSelectFile={(id) => onSelectFile(selectedFileId === id ? null : id)}
              renderActions={renderActions}
            />
          </div>
        ) : (
          <div className={`${CONTENT_MAX} p-4`}>
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
      ) : searching ? (
        /* Substring-filtered listing (instant, as you type) — over the CORPUS,
           so a match two folders down is reachable from anywhere. */
        filteredFiles.length === 0 ? (
          <div className="p-8">
            <EmptyState
              variant="bare"
              icon={Search}
              title={t('browser.noMatch', { query: search })}
              description={t('browser.noMatchDescription')}
              action={
                <Button variant="outline" size="sm" onClick={clearSearch}>
                  {t('browser.clearSearch')}
                </Button>
              }
            />
          </div>
        ) : view === 'list' ? (
          <div className={CONTENT_MAX}>
            <FileListView
              files={filteredFiles}
              selectedFileId={selectedFileId}
              onSelectFile={(id) => onSelectFile(selectedFileId === id ? null : id)}
              renderActions={renderActions}
            />
          </div>
        ) : (
          <div className={`${CONTENT_MAX} p-4`}>
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
            </FileGrid>
          </div>
        )
      ) : levelEmpty ? (
        /* An empty folder keeps its breadcrumb (above) — the way back out and
           the "New folder" control stay where the reader expects them. */
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState
            icon={FolderOpen}
            title={t('browser.folderEmptyTitle')}
            description={t('browser.folderEmptyDescription')}
            action={uploadControl}
          />
        </div>
      ) : view === 'list' ? (
        <div className={CONTENT_MAX}>
          {folderNav && childFolders.length > 0 && (
            <div className="border-b px-2 py-2" role="group" aria-label={t('folders.heading')}>
              {childFolders.map((folder) => (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  itemCount={folderItemCount(folder.id)}
                  onOpen={folderNav.onNavigate}
                  onRenameFolder={folderNav.onRenameFolder}
                  onDeleteFolder={folderNav.onDeleteFolder}
                />
              ))}
            </div>
          )}
          {files.length > 0 && (
            <FileListView
              files={files}
              selectedFileId={selectedFileId}
              onSelectFile={(id) => onSelectFile(selectedFileId === id ? null : id)}
              renderActions={renderActions}
            />
          )}
        </div>
      ) : (
        <div className={`${CONTENT_MAX} p-4`}>
          {/* Section label — "Recently uploaded" at the corpus root, matching
              the click-dummy. Hidden inside a folder (the breadcrumb already
              names it) and while searching (the query is the context). */}
          {currentFolderId === null && files.length > 0 && (
            <SectionLabel as="p" className="mb-3 font-semibold tracking-[0.05em]">
              {t('browser.recentlyUploaded')}
            </SectionLabel>
          )}
          <FileGrid>
            {folderNav &&
              childFolders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  itemCount={folderItemCount(folder.id)}
                  onOpen={folderNav.onNavigate}
                  onRenameFolder={folderNav.onRenameFolder}
                  onDeleteFolder={folderNav.onDeleteFolder}
                />
              ))}
            {files.map((file) => (
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
      )}
    </div>
  )
}

/**
 * The listing's width cap. With the tree band gone the browser owns the whole
 * column, and a 4K monitor would otherwise stretch cards into a wall — the
 * content centres inside the toolbars, which keep spanning the full width.
 */
const CONTENT_MAX = 'mx-auto w-full max-w-[1200px]'
