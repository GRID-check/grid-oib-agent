'use client'

import type { JSX } from 'react'
import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
import type { FileItem, FolderItem } from '../file-types'
import type { CardExtras } from '../lib/file-shelf'
import { EVERY_PROJECT_MEMBER, type FolderGrantItem } from '@/adapters/api/folder-access-client'
import { Search, SearchX, FilterX, FolderOpen, Sparkles } from 'lucide-react'
import { RisoPrint } from '@/components/brand/riso-print'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileSearch } from '../hooks/use-file-search'
import { useLevelDirection } from '../hooks/use-level-direction'
import { motion, motionEntrance } from '@/components/motion'
import { ActionMenu } from '@/components/ui/action-menu'
import { FileCard } from './file-card'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { FileListSkeleton, FileListView } from './file-list-view'
import { FolderActionsTrigger, FolderObjectMenu } from './folder-object-menu'
import { listingActionEntries } from './listing-action-entries'
import { NewFolderDialog } from './new-folder-dialog'
import { DEFAULT_FILE_SORT, sortFiles, type FileSort } from '../lib/file-sort'
import {
  FolderBreadcrumbRow,
  FolderBreadcrumbRowSkeleton,
  FolderCard,
  FolderCardSkeleton,
  FolderRow,
  FolderRowSkeleton,
} from './folder-navigation'
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
  /**
   * A viewer who may look and not touch: the tree is walkable, and there is no
   * „Neuer Ordner", no rename or delete, no context menu on a tile.
   */
  readOnly?: boolean
  /**
   * Open the folder's access dialog (ADR-0081). Present only for a reader who
   * manages the project; absent hides „Zugriff…" from the folder menu. A
   * project's folders only: the Archiv's are governed by who manages it.
   */
  onEditFolderAccess?: (folderId: string) => void
  /** Role slugs → names, for the lock on a folder with its own list. Slugs show as themselves without it. */
  roleNames?: (slugs: readonly string[]) => string[]
  /**
   * What the reader may do at the project root (ADR-0081): `read` hides the
   * root's upload and new-folder affordances. Absent reads as `write`; each
   * folder carries its own `access`. The server decides either way.
   */
  rootAccess?: 'read' | 'write'
}

/** Whether the reader may write at `folderId` (null: the root), as the listing reported it. */
export function mayWriteAt(folderNav: FolderNavigation | undefined, folderId: string | null): boolean {
  if (!folderNav) return true
  if (folderId === null) return folderNav.rootAccess !== 'read'
  return folderNav.folders.find((folder) => folder.id === folderId)?.access !== 'read'
}

interface FileBrowserPaneProps {
  /** The CURRENT LEVEL's files (the caller applies the folder filter). */
  files: readonly FileItem[]
  /**
   * The order both views draw in, owned by the caller: the list's column headers
   * and the header's filter menu write to one place, and switching views keeps
   * the order you chose. The pane orders what it hands to the cards and passes
   * the same state to the list.
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
   * Without it, a filter that matches nothing would render "this folder is
   * empty" over a folder full of documents.
   */
  filterEmptyNotice?: { title: string; description: string; onClear: () => void } | null
  /**
   * Move a document into a folder by dragging it there. Absent turns the drag
   * OFF (a read-only viewer): a card that lifts under the finger where nothing
   * can receive it promises a move this surface cannot make.
   */
  onDropDocumentInFolder?: (documentId: string, folderId: string | null) => void
  /**
   * Re-parent one folder into another by dragging it there. Absent turns the
   * folder drag off entirely, for the same reason as the document drag.
   */
  onDropFolderInFolder?: (draggedFolderId: string, parentId: string | null) => void
  /** Upload control rendered inside the first-run empty state. */
  uploadControl?: ReactNode
  /** Dashed upload card rendered as the last tile of the grid (project corpus). */
  uploadCard?: ReactNode
  /**
   * Folder drill-down: breadcrumb path on top, folder cards/rows beside the
   * files, create/rename/delete in place. Omitted by callers that have no
   * folder listing to show (a fixture, a failed folder read).
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
  /**
   * A shelf's own mark on a card: the Büroarchiv's gold kind chip and the line
   * saying where it came from. Cards only — a row has no room for either.
   */
  cardExtras?: (file: FileItem) => CardExtras
  /** Per-file rename / delete / download — shown on the card and the list row. */
  renderActions?: (file: FileItem) => ReactNode
  /** Wrap a file card (right-click host). */
  wrapFile?: (file: FileItem, node: ReactNode) => ReactNode
  wrapFileRow?: (file: FileItem, row: ReactNode) => ReactNode
  onViewChange?: (view: 'cards' | 'list') => void
  onPickFiles?: () => void
  onPickFolder?: () => void
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
  onDropFolderInFolder,
  renderActions,
  cardExtras,
  wrapFile,
  wrapFileRow,
  onViewChange,
  onPickFiles,
  onPickFolder,
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
  // A level the reader may only read offers no upload and no new folder
  // (ADR-0081); a notice says why. The server refuses either way.
  const writableHere = mayWriteAt(folderNav, currentFolderId)
  const [createFolderIn, setCreateFolderIn] = useState<string | null | undefined>(undefined)
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)

  const listingEntries = useMemo(
    () =>
      listingActionEntries({
        labels: {
          newFolder: t('folders.newFolder'),
          uploadFiles: t('upload.uploadFiles'),
          uploadFolder: t('upload.uploadFolder'),
          viewCards: t('workspace.view.cards'),
          viewList: t('workspace.view.list'),
          sortName: t('list.columns.name'),
          sortStatus: t('list.columns.status'),
          sortSize: t('list.columns.size'),
          sortAdded: t('list.columns.added'),
        },
        view,
        sort,
        onNewFolder:
          folderNav && !folderNav.readOnly && writableHere && !semantic.active && query.trim() === ''
            ? () => setCreateFolderIn(currentFolderId)
            : undefined,
        onUploadFiles: writableHere ? onPickFiles : undefined,
        onUploadFolder: writableHere ? onPickFolder : undefined,
        onViewChange,
        onSortChange,
      }),
    [
      t,
      view,
      sort,
      folderNav,
      semantic.active,
      query,
      currentFolderId,
      writableHere,
      onPickFiles,
      onPickFolder,
      onViewChange,
      onSortChange,
    ],
  )

  const fileCard = (file: FileItem, extra: { match?: Parameters<typeof FileCard>[0]['match'] } = {}) => {
    const card = (
      <FileCard
        file={file}
        isSelected={selectedFileId === file.id}
        onSelect={() => onSelectFile(file.id)}
        locale={locale}
        match={extra.match}
        footerLead={
          showAssignment ? <AssignmentFaces assignees={file.assignees} /> : undefined
        }
        {...cardExtras?.(file)}
        actions={renderActions?.(file)}
        draggable={Boolean(onDropDocumentInFolder)}
      />
    )
    return wrapFile ? wrapFile(file, card) : card
  }

  /** A folder's own list as the lock names it: each role (or every member) with what it may do. */
  const grantLabels = (grants: readonly FolderGrantItem[]): string[] => {
    const names = folderNav?.roleNames?.(grants.map((grant) => grant.role)) ?? grants.map((grant) => grant.role)
    return grants.map((grant, index) => {
      const who = grant.role === EVERY_PROJECT_MEMBER ? t('folders.access.everyMember') : names[index]
      const what = grant.level === 'write' ? t('folders.access.levelWrite') : t('folders.access.levelRead')
      return `${who} (${what})`
    })
  }

  const folderTile = (folder: FolderItem, asRow: boolean) => {
    const props = {
      folder,
      itemCount: folderItemCount(folder.id),
      lastModified: folderLastModified(folder.id),
      onOpen: folderNav!.onNavigate,
      onRenameFolder: folderNav!.onRenameFolder,
      onDeleteFolder: folderNav!.onDeleteFolder,
      onDropDocument: onDropDocumentInFolder,
      onDropFolder: onDropFolderInFolder,
      canAcceptFolder,
      actions: folderNav ? (folderNav.readOnly ? <Fragment /> : <FolderActionsTrigger />) : undefined,
      editing: editingFolderId === folder.id,
      onEditingChange: (next: boolean) => setEditingFolderId(next ? folder.id : null),
      restrictedRoleNames: folder.grants?.length ? grantLabels(folder.grants) : undefined,
      readOnly: folder.access === 'read',
    }
    const tile = asRow ? <FolderRow {...props} /> : <FolderCard {...props} />
    if (!folderNav || folderNav.readOnly) return tile
    return (
      <FolderObjectMenu
        folder={folder}
        folders={folderNav.folders}
        canAcceptMove={(target) => canAcceptFolder(folder.id, target)}
        onOpen={() => folderNav.onNavigate(folder.id)}
        onNewInside={() => setCreateFolderIn(folder.id)}
        onRename={() => setEditingFolderId(folder.id)}
        onMove={
          onDropFolderInFolder
            ? (parentId) => void onDropFolderInFolder(folder.id, parentId)
            : undefined
        }
        onAccess={
          folderNav.onEditFolderAccess ? () => folderNav.onEditFolderAccess?.(folder.id) : undefined
        }
        onDelete={() => void folderNav.onDeleteFolder(folder.id)}
        readOnly={folder.access === 'read'}
      >
        {tile}
      </FolderObjectMenu>
    )
  }

  /**
   * Which way the level moved: deeper slides in from the right, shallower from
   * the left. Zero is the first paint and every render that is not a level
   * change, which is what keeps a server-rendered listing from sliding in under
   * a reader who has not navigated anywhere.
   *
   * The derivation lives in {@link useLevelDirection}, not in refs written
   * during render, which went wrong in a way that only showed up as "the
   * animation goes the wrong way sometimes".
   */
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

  const navDirection = useLevelDirection(folderDepth)

  /**
   * Whether a folder may be dropped on a given target — asked DURING the drag,
   * so a target that cannot take it never highlights.
   *
   * Three refusals, and the third is the one that matters. A folder is not its
   * own parent; a move into the parent it already has is a no-op dressed up as
   * a gesture; and a folder cannot go inside its own descendant, which would
   * cut the subtree off from the tree entirely. `updateProjectFolder` refuses
   * all three server-side — this is what stops the reader being invited to make
   * a move that will be rejected.
   *
   * The ancestor walk is bounded by the folder count rather than trusting the
   * tree to be acyclic: `parentId` comes off the wire, and a cycle here would
   * be an infinite loop inside a `dragover` handler.
   */
  const canAcceptFolder = useCallback(
    (draggedId: string, targetId: string | null): boolean => {
      if (draggedId === targetId) return false
      // A move is a write into the target (ADR-0081): a read-only one never lights up.
      if (!mayWriteAt(folderNav, targetId)) return false
      const all = folderNav?.folders ?? []
      const dragged = all.find((folder) => folder.id === draggedId)
      if (!dragged) return false
      if ((dragged.parentId ?? null) === targetId) return false
      if (targetId === null) return true
      const byId = new Map(all.map((folder) => [folder.id, folder]))
      let cursor: string | null = targetId
      for (let step = 0; cursor !== null && step <= all.length; step += 1) {
        if (cursor === draggedId) return false
        cursor = byId.get(cursor)?.parentId ?? null
      }
      return true
    },
    [folderNav]
  )

  /** The folders directly inside the current level — the drill-down tiles. */
  const childFolders = useMemo(
    () => (folderNav?.folders ?? []).filter((f) => f.parentId === currentFolderId),
    [folderNav?.folders, currentFolderId]
  )

  /**
   * The two numbers every folder card shows — its item count and the newest
   * thing under it — for the WHOLE tree, in one pass.
   *
   * Computed per card, each number re-scans the corpus: the count filters every
   * document and every folder, and the timestamp does that AND recurses into
   * each subtree, re-filtering the corpus again at every level. A project with
   * 500 documents and 30 folders would pay roughly 30 × (530 + subtree)
   * comparisons on every render — every keystroke in the search field, every
   * poll that replaces the listing, every folder card's hover state.
   *
   * Nothing about the answer needs a scan per card. Both facts are aggregates
   * over the same two groupings, so they are built once: documents by folder,
   * folders by parent, then one post-order walk that hands each parent what its
   * children already computed. Linear in the corpus, and memoized on the inputs
   * it actually reads.
   *
   * The walk is iterative and marks visited nodes rather than recursing, because
   * `parentId` comes off the wire and a cycle in it would otherwise be a stack
   * overflow in a render.
   */
  const folderAggregates = useMemo(() => {
    const corpus = searchFiles ?? files
    const allFolders = folderNav?.folders ?? []

    const docsByFolder = new Map<string, FileItem[]>()
    for (const file of corpus) {
      const key = file.folderId ?? null
      if (key === null) continue
      const bucket = docsByFolder.get(key)
      if (bucket) bucket.push(file)
      else docsByFolder.set(key, [file])
    }

    const childrenByParent = new Map<string, FolderItem[]>()
    for (const folder of allFolders) {
      const key = folder.parentId
      if (key === null) continue
      const bucket = childrenByParent.get(key)
      if (bucket) bucket.push(folder)
      else childrenByParent.set(key, [folder])
    }

    /** Direct children only — what the card's "N items" line counts. */
    const counts = new Map<string, number>()
    /** Newest `createdAt` anywhere in the subtree, or null for an empty one. */
    const lastModified = new Map<string, string | null>()

    const visited = new Set<string>()
    for (const root of allFolders) {
      if (visited.has(root.id)) continue
      // Post-order: a folder is settled only once every child of it is, so the
      // stack carries each node twice — once to expand, once to fold up.
      const stack: Array<{ id: string; expanded: boolean }> = [{ id: root.id, expanded: false }]
      while (stack.length > 0) {
        const frame = stack.pop()!
        if (!frame.expanded) {
          if (visited.has(frame.id)) continue
          visited.add(frame.id)
          stack.push({ id: frame.id, expanded: true })
          for (const child of childrenByParent.get(frame.id) ?? []) {
            if (!visited.has(child.id)) stack.push({ id: child.id, expanded: false })
          }
          continue
        }
        const docs = docsByFolder.get(frame.id) ?? []
        const children = childrenByParent.get(frame.id) ?? []
        counts.set(frame.id, docs.length + children.length)
        let latest: string | null = null
        for (const doc of docs) {
          if (doc.createdAt && (latest === null || doc.createdAt > latest)) latest = doc.createdAt
        }
        for (const child of children) {
          const nested = lastModified.get(child.id) ?? null
          if (nested && (latest === null || nested > latest)) latest = nested
        }
        lastModified.set(frame.id, latest)
      }
    }

    return { counts, lastModified }
  }, [files, searchFiles, folderNav?.folders])

  /** Documents + subfolders directly inside `folderId`, for the count line. */
  const folderItemCount = (folderId: string): number => folderAggregates.counts.get(folderId) ?? 0

  /** Most recent child timestamp — the folder's "last change", like file cards show. */
  const folderLastModified = (folderId: string): string | null =>
    folderAggregates.lastModified.get(folderId) ?? null

  if (isLoading) {
    return (
      <FileBrowserSkeleton view={view} withFolders={folderNav !== undefined} uploadCard={uploadCard} />
    )
  }

  // A FILTER EMPTIED IT, AND THAT OUTRANKS BOTH EMPTY STATES BELOW.
  //
  // Checked first because a filter that matches nothing empties the CORPUS,
  // not just the level — which would send the reader to the first-run "no
  // documents yet, upload one" panel in a project with a hundred documents in
  // it. Both states below describe an absence of files; this one describes an
  // absence of MATCHES, and only it can name what to do about it.
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
          art={<RisoPrint id="vignetten/planschrank/empty" />}
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
          and it would move the whole listing down a row the moment a search ran.
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
          onCreateFolder={folderNav.readOnly ? undefined : folderNav.onCreateFolder}
          onDropDocument={onDropDocumentInFolder}
          onDropFolder={onDropFolderInFolder}
          canAcceptFolder={canAcceptFolder}
          readOnly={!writableHere}
        />
      )}

      <ActionMenu mode="context" entries={listingEntries}>
      {semantic.active ? (
        // Semantic results — one card per matched file, each showing the match
        // evidence (snippet + page + relevance). A backend error/timeout fails
        // open to an empty result set (never a crash).
        semantic.isSearching ? (
          // Placeholders shaped like the view the answer will arrive in, so a search
          // from the list does not flash a wall of tiles before it snaps to a table.
          view === 'list' ? (
            <div className={CONTENT_MAX}>
              <FileListSkeleton />
            </div>
          ) : (
            // The cap the answer will be drawn inside. Without it the running search
            // would fill the full width, and the results would snap to 1200px under the
            // reader the instant they arrived.
            <div className={`${CONTENT_MAX} p-4`}>
              <FileGrid>
                {Array.from({ length: 6 }).map((_, i) => (
                  <FileCardSkeleton key={i} />
                ))}
              </FileGrid>
            </div>
          )
        ) : semantic.error ? (
          // A SEARCH THAT NEVER RAN IS NOT A SEARCH THAT FOUND NOTHING.
          // The hook fails open to an empty result set so this pane cannot crash, and
          // it reports which of the two happened. The pane reads that flag: a backend
          // timeout must not render as "Keine semantischen Treffer", which tells the
          // reader their own corpus lacks what they searched for.
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
          /* The view toggle keeps meaning while searching: a reader who has switched
             to the detail view stays there when they press Enter, and when they
             clear the query.
             `key` on the query so a new result set starts at the top of its own
             ranking rather than inheriting the last one's sort and tab stop. */
          <div className={CONTENT_MAX}>
            <FileListView
              key={semantic.query ?? ''}
              semantic
              files={semantic.hits}
              selectedFileId={selectedFileId}
              onSelectFile={onSelectFile}
              renderActions={renderActions}
              wrapRow={wrapFileRow}
            />
          </div>
        ) : (
          <div className={`${CONTENT_MAX} p-4`}>
            <FileGrid>
              {semantic.hits.map((hit) => (
                <Fragment key={hit.id}>
                  {fileCard(hit, { match: { snippet: hit.snippet, page: hit.page, score: hit.score } })}
                </Fragment>
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
              onSelectFile={onSelectFile}
              renderActions={renderActions}
              wrapRow={wrapFileRow}
              sort={sort}
              onSortChange={onSortChange}
            />
          </div>
        ) : (
          <div className={`${CONTENT_MAX} p-4`}>
            <FileGrid>
              {filteredFiles.map((file) => (
                <Fragment key={file.id}>{fileCard(file)}</Fragment>
              ))}
            </FileGrid>
          </div>
        )
      ) : levelEmpty ? (
        /* An empty folder keeps its breadcrumb (above) — the way back out and
           the "New folder" control stay where the reader expects them. */
        <motion.div
          key={`empty-${currentFolderId ?? 'root'}`}
          {...levelTransition(navDirection, 16)}
          className="flex flex-1 items-center justify-center p-8"
        >
          <EmptyState
            icon={FolderOpen}
            title={t('browser.folderEmptyTitle')}
            description={t('browser.folderEmptyDescription')}
            action={writableHere ? uploadControl : undefined}
          />
        </motion.div>
      ) : view === 'list' ? (
        <motion.div
          key={`list-${currentFolderId ?? 'root'}`}
          {...levelTransition(navDirection, 16)}
          className={CONTENT_MAX}
        >
            {folderNav && childFolders.length > 0 && (
              <div className="border-b px-2 py-2" role="group" aria-label={t('folders.heading')}>
                {childFolders.map((folder) => (
                  <Fragment key={folder.id}>{folderTile(folder, true)}</Fragment>
                ))}
              </div>
            )}
            {orderedFiles.length > 0 && (
              <FileListView
                files={orderedFiles}
                selectedFileId={selectedFileId}
                onSelectFile={onSelectFile}
                renderActions={renderActions}
                wrapRow={wrapFileRow}
                sort={sort}
                onSortChange={onSortChange}
                draggable={Boolean(onDropDocumentInFolder)}
              />
            )}
        </motion.div>
      ) : (
        <motion.div
          key={`grid-${currentFolderId ?? 'root'}`}
          {...levelTransition(navDirection, 20)}
          className={`${CONTENT_MAX} p-4`}
        >
            {/* Section label — "Recently uploaded" at the corpus root. Hidden inside
                a folder (the breadcrumb already names it) and while searching (the
                query is the context). */}
            {currentFolderId === null && files.length > 0 && (
              <SectionLabel as="p" className="mb-3 font-semibold tracking-[0.05em]">
                {t('browser.recentlyUploaded')}
              </SectionLabel>
            )}
            {/*
              ONE ENTRANCE FOR THE LEVEL, NOT ONE PER TILE.

              Each cell is not wrapped in its own `motion.div` rising 10px on a
              per-index delay: those compound. The level already slides in
              sideways, so a navigation would play N+1 animations at once, each
              tile drifting up through a container drifting across, and a
              per-index delay puts the last tile of a full Einreichung ten
              seconds out.

              The serious problem is that motion writes `initial` into the
              SERVER's HTML. The listing is rendered on the server, so every card
              would ship with `opacity: 0` and stay invisible until the bundle
              boots and hydration releases it: a blank grid over data that is
              already in the document, the exact wait the server render exists
              to remove.

              The level's own transition carries the whole grid. That is one
              animation, it is what a Finder-style drill actually looks like, and
              it renders at full opacity when nothing has navigated.
            */}
            <FileGrid>
              {folderNav &&
                childFolders.map((folder) => (
                  <Fragment key={folder.id}>{folderTile(folder, false)}</Fragment>
                ))}
              {orderedFiles.map((file) => (
                <Fragment key={file.id}>{fileCard(file)}</Fragment>
              ))}
              {writableHere && uploadCard}
            </FileGrid>
        </motion.div>
      )}
      </ActionMenu>
      {folderNav && !folderNav.readOnly && (
        <NewFolderDialog
          open={createFolderIn !== undefined}
          onOpenChange={(open) => {
            if (!open) setCreateFolderIn(undefined)
          }}
          onCreate={(name) => folderNav.onCreateFolder(name, createFolderIn ?? undefined)}
        />
      )}
    </div>
  )
}



/**
 * ENTERING A FOLDER IS AN ARRIVAL, NOT A HANDOVER.
 *
 * The level is not wrapped in `AnimatePresence mode="wait"`: `wait` plays the
 * level you are leaving to completion before the one you asked for begins. Two
 * 180ms tweens end to end leave a frame where the pane holds nothing and
 * collapses to the height of its own padding, on the gesture this page is built
 * around, which a person repeats a dozen times walking a tree.
 *
 * Nothing needs the outgoing level watched on its way out. Without the presence
 * wrapper the swap is instant and only the arrival animates, and the arrival
 * carries the direction: the new level slides in from the side it came from, in
 * one 240ms entrance, over content that is already there.
 *
 * `initial: false` when the direction is 0 — no navigation happened, so this is
 * the first paint (a server-rendered listing, which must not slide) or a
 * re-render the key did not change.
 */
const levelTransition = (direction: number, distance: number) =>
  ({
    initial: direction === 0 ? false : { opacity: 0, x: direction * distance },
    animate: { opacity: 1, x: 0 },
    transition: motionEntrance,
  }) as const

/**
 * THE FIRST FRAME, SHAPED LIKE THE SECOND ONE.
 *
 * This is the placeholder the whole pane renders while the listing is being
 * read. It lives beside the listing rather than in a loading file, because the
 * failure it prevents is drift: a skeleton that does not share the loaded layout
 * makes every load end in a jump.
 *
 * What it mirrors, in the order the real pane renders them:
 *
 *   - the breadcrumb row, at its real height, when this surface has folders;
 *   - the content cap, so the grid does not start full-width and then narrow;
 *   - the „Zuletzt hochgeladen" eyebrow, which is always there at the root;
 *   - folder tiles BEFORE file tiles, which is the order the grid fills in;
 *   - the dashed upload tile, which is the last cell of a project's grid.
 *
 * It cannot know how many of each are coming. It draws a plausible few — the
 * point of a skeleton is the shape of the page, not a forecast of its contents.
 */
export function FileBrowserSkeleton({
  view = 'cards',
  withFolders = false,
  uploadCard,
  /** Placeholder folder tiles. Two: enough to read as "folders come first". */
  folders = 2,
  files = 6,
}: {
  view?: 'cards' | 'list'
  withFolders?: boolean
  /**
   * The REAL dashed upload tile, not a grey stand-in for it.
   *
   * It is the one cell of this grid whose content does not depend on the answer
   * being fetched, and it opens a file picker: greying it out would hide a
   * working control and make the grid one tile shorter than it is about to be.
   */
  uploadCard?: ReactNode
  folders?: number
  files?: number
}): JSX.Element {
  const folderCount = withFolders ? folders : 0
  return (
    <div className="flex h-full flex-col" data-testid="file-browser-skeleton">
      {withFolders && <FolderBreadcrumbRowSkeleton />}
      {view === 'list' ? (
        <div className={CONTENT_MAX}>
          {folderCount > 0 && (
            <div className="space-y-1 border-b px-2 py-2">
              {Array.from({ length: folderCount }).map((_, index) => (
                <FolderRowSkeleton key={index} />
              ))}
            </div>
          )}
          <FileListSkeleton rows={files} />
        </div>
      ) : (
        <div className={`${CONTENT_MAX} p-4`}>
          <Skeleton className="mb-3 h-3 w-36" />
          <FileGrid>
            {Array.from({ length: folderCount }).map((_, index) => (
              <FolderCardSkeleton key={`folder-${index}`} />
            ))}
            {Array.from({ length: files }).map((_, index) => (
              <FileCardSkeleton key={`file-${index}`} />
            ))}
            {uploadCard}
          </FileGrid>
        </div>
      )}
    </div>
  )
}


/**
 * The listing's width cap. With no tree band beside it, the browser owns the whole
 * column, and a 4K monitor would otherwise stretch cards into a wall — the
 * content centres inside the toolbars, which keep spanning the full width.
 */
const CONTENT_MAX = 'mx-auto w-full max-w-[1200px]'
