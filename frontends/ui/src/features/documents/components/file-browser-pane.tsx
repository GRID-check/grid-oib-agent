'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import type { FileItem, FolderItem } from './project-file-workspace'
import { Search, SearchX, FilterX, FolderOpen, Sparkles, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileSearch } from '../hooks/use-file-search'
import { AnimatePresence, motion, motionEntrance, motionQuick } from '@/components/motion'
import { FileCard } from './file-card'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { FileListSkeleton, FileListView } from './file-list-view'
import { DEFAULT_FILE_SORT, sortFiles, type FileSort } from '../lib/file-sort'
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
  files: readonly FileItem[]
  /**
   * The order both views draw in, owned by the caller.
   *
   * The detail view used to hold this privately, so the card grid had no order
   * at all and switching views discarded the one you had chosen. The pane
   * orders what it hands to the cards and passes the same state to the list, so
   * the list's column headers and the header's filter menu write to one place.
   *
   * Omitted by fixtures, which then get the default (newest first).
   */
  sort?: FileSort
  onSortChange?: (next: FileSort) => void
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
  /**
   * What emptied this level, when a FILTER did rather than the folder being
   * empty. The pane is handed already-filtered files and cannot tell the two
   * apart; the caller owns the filter state, so it owns the sentence.
   *
   * Without it, turning on a filter that matches nothing rendered "this folder
   * is empty" over a folder full of documents — which is how „Von Piloti" came
   * to read as a broken or meaningless filter rather than an empty one.
   */
  filterEmptyNotice?: { title: string; description: string; onClear: () => void } | null
  /**
   * Move a document into a folder by dragging it there. Absent on a surface
   * with no folders (the Archiv), which is also what turns the drag OFF: a card
   * that lifts under the finger where nothing can receive it promises a move
   * this surface cannot make.
   */
  onDropDocumentInFolder?: (documentId: string, folderId: string | null) => void
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
  searchFiles?: readonly FileItem[]
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
  uploadControl,
  uploadCard,
  folderNav,
  searchFiles,
  search,
  view = 'cards',
  showAssignment = false,
  filterEmptyNotice,
  onDropDocumentInFolder,
  renderActions,
  sort = DEFAULT_FILE_SORT,
  onSortChange,
}: FileBrowserPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const { query, semantic } = search

  // The level, ordered. The list view re-applies the identical sort to the rows
  // it is handed — a no-op, and cheaper than teaching every branch below which
  // of the two views it is about to render into.
  const orderedFiles = useMemo(() => sortFiles(files, sort, locale), [files, sort, locale])

  // Client-side filter: name, plus AI tags and summary when the backend
  // generated them. A typed query escapes the current folder (the query is the
  // context), so it runs over the corpus, not the level.
  const filteredFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orderedFiles
    // Both names, deliberately: somebody who renamed a document looks for what
    // they called it, and somebody who uploaded it looks for the file they sent.
    return sortFiles(
      (searchFiles ?? files).filter(
        (f) =>
          documentDisplayName(f).toLowerCase().includes(q) ||
          f.filename.toLowerCase().includes(q) ||
          (f.summary ?? '').toLowerCase().includes(q) ||
          (f.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      ),
      sort,
      locale
    )
  }, [orderedFiles, files, searchFiles, query, sort, locale])

  const currentFolderId = folderNav?.currentFolderId ?? null

  // Direction for the folder-level transition: deeper (entering) slides left,
  // shallower (leaving) slides right. Tracked so the AnimatePresence can pick
  // the right variant without guessing from the DOM.
  const prevFolderRef = useRef<string | null>(currentFolderId)
  const prevDepthRef = useRef(0)
  const folderDepth = useMemo(() => {
    if (!folderNav || currentFolderId === null) return 0
    let depth = 0
    let cur: string | null = currentFolderId
    const byId = new Map(folderNav.folders.map((f) => [f.id, f]))
    while (cur) {
      depth += 1
      cur = byId.get(cur)?.parentId ?? null
      if (depth > folderNav.folders.length) break
    }
    return depth
  }, [folderNav, currentFolderId])
  const navDirection = folderDepth > prevDepthRef.current ? 1 : folderDepth < prevDepthRef.current ? -1 : 0
  prevFolderRef.current = currentFolderId
  prevDepthRef.current = folderDepth

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

  /** Most recent child timestamp — the folder's "last change", like file cards show. */
  const folderLastModified = (folderId: string): string | null => {
    const childDocs = (searchFiles ?? files).filter((f) => (f.folderId ?? null) === folderId)
    if (childDocs.length === 0) return null
    let latest: string | null = null
    for (const doc of childDocs) {
      if (!doc.createdAt) continue
      if (latest === null || doc.createdAt > latest) latest = doc.createdAt
    }
    // Include nested folders' children recursively — deepest newest wins
    const childFolderIds = (folderNav?.folders ?? []).filter((f) => f.parentId === folderId).map((f) => f.id)
    for (const childId of childFolderIds) {
      const nested = folderLastModified(childId)
      if (nested && (latest === null || nested > latest)) latest = nested
    }
    return latest
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

  // A FILTER EMPTIED IT, AND THAT OUTRANKS BOTH EMPTY STATES BELOW.
  //
  // Checked first because a filter that matches nothing empties the CORPUS,
  // not just the level — which sent the reader to the first-run "no documents
  // yet, upload one" panel in a project with a hundred documents in it. Both
  // states below describe an absence of files; this one describes an absence
  // of MATCHES, and only it can name what to do about it.
  if (filterEmptyNotice) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          variant="bare"
          icon={FilterX}
          title={filterEmptyNotice.title}
          description={filterEmptyNotice.description}
          action={
            <Button variant="outline" size="sm" onClick={filterEmptyNotice.onClear}>
              {t('browser.clearFilters')}
            </Button>
          }
        />
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

  const searching = query.trim() !== ''
  const levelEmpty = files.length === 0 && childFolders.length === 0

  return (
    <div className="flex h-full flex-col">
      {/* No banner over the results. It restated in a tinted strip what the
          listing below it already shows — how many hits, for which query —
          and it moved the whole listing down a row the moment a search ran.
          Everything it carried has a better home: the skeletons say a search
          is running, the empty and failed panels say what came back, and the
          field's own ✕ is the way out. The field itself is the caller's — on
          Files it sits in the page header, one component above this one. */}

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
          onDropDocument={onDropDocumentInFolder}
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
          <div className={CONTENT_MAX}>
            <FileListView
              files={filteredFiles}
              selectedFileId={selectedFileId}
              onSelectFile={(id) => onSelectFile(selectedFileId === id ? null : id)}
              renderActions={renderActions}
              sort={sort}
              onSortChange={onSortChange}
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
        <motion.div
          key={`empty-${currentFolderId ?? 'root'}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={motionEntrance}
          className="flex flex-1 items-center justify-center p-8"
        >
          <EmptyState
            icon={FolderOpen}
            title={t('browser.folderEmptyTitle')}
            description={t('browser.folderEmptyDescription')}
            action={uploadControl}
          />
        </motion.div>
      ) : view === 'list' ? (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`list-${currentFolderId ?? 'root'}`}
            initial={{ opacity: 0, x: navDirection * 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: navDirection * -16 }}
            transition={motionQuick}
            className={CONTENT_MAX}
          >
            {folderNav && childFolders.length > 0 && (
              <div className="border-b px-2 py-2" role="group" aria-label={t('folders.heading')}>
                {childFolders.map((folder) => (
                  <FolderRow
                    key={folder.id}
                    folder={folder}
                    itemCount={folderItemCount(folder.id)}
                    lastModified={folderLastModified(folder.id)}
                    onOpen={folderNav.onNavigate}
                    onRenameFolder={folderNav.onRenameFolder}
                    onDeleteFolder={folderNav.onDeleteFolder}
                    onDropDocument={onDropDocumentInFolder}
                  />
                ))}
              </div>
            )}
            {orderedFiles.length > 0 && (
              <FileListView
                files={orderedFiles}
                selectedFileId={selectedFileId}
                onSelectFile={(id) => onSelectFile(selectedFileId === id ? null : id)}
                renderActions={renderActions}
                sort={sort}
                onSortChange={onSortChange}
              />
            )}
          </motion.div>
        </AnimatePresence>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`grid-${currentFolderId ?? 'root'}`}
            initial={{ opacity: 0, x: navDirection * 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: navDirection * -20 }}
            transition={motionQuick}
            className={`${CONTENT_MAX} p-4`}
          >
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
                childFolders.map((folder, idx) => (
                  <motion.div
                    key={folder.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...motionEntrance, delay: idx * 0.03 }}
                  >
                    <FolderCard
                      folder={folder}
                      itemCount={folderItemCount(folder.id)}
                      lastModified={folderLastModified(folder.id)}
                      onOpen={folderNav.onNavigate}
                      onRenameFolder={folderNav.onRenameFolder}
                      onDeleteFolder={folderNav.onDeleteFolder}
                      onDropDocument={onDropDocumentInFolder}
                    />
                  </motion.div>
                ))}
              {orderedFiles.map((file, idx) => (
                <motion.div
                  key={file.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...motionEntrance, delay: (childFolders.length + idx) * 0.02 }}
                >
                  <FileCard
                    file={file}
                    isSelected={selectedFileId === file.id}
                    onSelect={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
                    locale={locale}
                    footerLead={showAssignment ? <AssignmentFaces assignees={file.assignees} /> : undefined}
                    actions={renderActions?.(file)}
                    draggable={Boolean(onDropDocumentInFolder)}
                  />
                </motion.div>
              ))}
              {uploadCard && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...motionEntrance, delay: (childFolders.length + files.length) * 0.02 }}
                >
                  {uploadCard}
                </motion.div>
              )}
            </FileGrid>
          </motion.div>
        </AnimatePresence>
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
