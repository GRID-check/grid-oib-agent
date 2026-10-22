'use client'

import type { JSX } from 'react'
import { Fragment, memo, useCallback, useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import type { FileItem, FolderItem } from '../file-types'
import type { CardExtras } from '../lib/file-shelf'
import { CheckSquare, Search, SearchX, FilterX, FolderOpen, Sparkles } from 'lucide-react'
import { RisoPrint } from '@/components/brand/riso-print'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ItemList } from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import { tagLabel } from '@/lib/documents/tag-vocabulary'
import type { FileSearch } from '../hooks/use-file-search'
import { useCoarsePointer } from '../hooks/use-coarse-pointer'
import { useLevelDirection } from '../hooks/use-level-direction'
import { motion, motionEntrance } from '@/components/motion'
import { ActionMenu } from '@/components/ui/action-menu'
import { useMoveInSheet } from './document-actions'
import { FileCard, type FileCardProps } from './file-card'
import { FilingViewBar } from './filing-bar'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { FileListSkeleton, FileListView } from './file-list-view'
import { FolderActionsTrigger, FolderObjectMenu } from './folder-object-menu'
import { FolderDescriptionLine } from './folder-description-dialog'
import { listingActionEntries } from './listing-action-entries'
import { NewFolderDialog } from './new-folder-dialog'
import { DEFAULT_FILE_SORT, sortFiles, type FileSort } from '../lib/file-sort'
import { subtreeTallies, type KnowledgeTally } from '../lib/folder-knowledge'
import { LoadMore } from '@/components/ui/load-more'
import { withoutOlderRevisions } from '../lib/revision-chain'
import {
  FolderBreadcrumbRow,
  FolderBreadcrumbRowSkeleton,
  FolderCard,
  FolderCardSkeleton,
  FolderRow,
  FolderRowSkeleton,
  FOLDER_ROWS_ON_PHONE,
  type DropFilesInFolder,
} from './folder-navigation'
import type { FileDropAim } from '../hooks/use-document-drag'
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
   * Open the folder's access dialog (ADR-0088). Present only for a reader who
   * manages the project; absent hides „Zugriff…" from the folder menu. A
   * project's folders only: the Archiv's are governed by who manages it.
   */
  onEditFolderAccess?: (folderId: string) => void
  /**
   * Open the folder's description (migration 0145): „Beschreibung …" in its
   * menu and the edit on the line at the top of the folder. Absent for a
   * reader who may not write the shelf.
   */
  onDescribeFolder?: (folderId: string) => void
  /**
   * What the reader may do at the project root (ADR-0088): `read` hides the
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
  /**
   * Files from the desktop released on a folder tile or a way up (a breadcrumb
   * segment, „Zurück") go into THAT folder. Absent leaves every file drop to the
   * surface around the pane, which files it in the folder on screen.
   */
  onDropFilesInFolder?: DropFilesInFolder
  /** Told which folder desktop files would land in while they hover a target, for the overlay to name it. */
  onFileAim?: (aim: FileDropAim | null) => void
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
   * Whether older Fassungen are listed. A search keeps one entry per document
   * too: an older match is dropped when its current Fassung matched as well.
   */
  showOlderRevisions?: boolean
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
   * A shelf's own mark on a card: the Büroablage's gold kind chip and the line
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
  /**
   * What Piloti knows about this level's whole subtree (`FolderBrief`), drawn
   * above the level. The caller builds it because the caller holds the
   * unfiltered corpus: the brief describes the folder, not the filter.
   */
  brief?: ReactNode
  /**
   * A slice of the subtree the brief opened — every failed document under this
   * folder, every Grundriss — drawn flat in place of the level, with the way
   * back. A folder's documents are spread over its subfolders; walking each to
   * find them is the chore the brief exists to remove. `loading` while the
   * documents it is drawn from are still being read (ADR-0102).
   */
  slice?: { files: readonly FileItem[]; label: string; onClear: () => void; loading?: boolean }
  /**
   * The level is read page by page (ADR-0102): the end of the grid or list
   * reads the next page when the reader reaches it. Absent: everything is here.
   */
  paging?: { hasMore: boolean; loading: boolean; failed: boolean; onLoadMore: () => void }
  /**
   * What every folder tile shows, counted by the server for the whole shelf
   * (the shelf summary, ADR-0102). Absent: folded from `searchFiles ?? files`,
   * which is the corpus only when the caller holds the whole shelf.
   */
  folderStats?: { counts: ReadonlyMap<string, number>; tallies: ReadonlyMap<string, KnowledgeTally> }
  /**
   * Whether the shelf holds no document at all, when the caller knows better
   * than the rows it handed over (a paged level, a search's results). Absent:
   * `searchFiles ?? files` is empty.
   */
  shelfEmpty?: boolean
  /**
   * The search matches file names only (a paged level asks the server, which
   * reads names; the content is the semantic search's). The empty result then
   * says so rather than suggesting a tag or a description.
   */
  searchMatchesNamesOnly?: boolean
  /**
   * Picking several documents (`useDocumentSelection`, owned by the caller,
   * who also owns what the picks are for). While `active`, a press on a card
   * or row toggles it, the ⋯ and the drag step aside, and ranked semantic hits
   * stay as they are: a result set is read, not filed.
   */
  selection?: FileBrowserSelection
}

export interface FileBrowserSelection {
  active: boolean
  selectedIds: ReadonlySet<string>
  onToggle: (documentId: string) => void
  /** „Auswählen" in the path row. Absent where nothing can be done to a selection. */
  onStart?: () => void
}

interface FileTileProps {
  file: FileItem
  isSelected: boolean
  onSelectFile: (id: string | null) => void
  locale: string
  match?: FileCardProps['match']
  showAssignment: boolean
  cardExtras?: (file: FileItem) => CardExtras
  renderActions?: (file: FileItem) => ReactNode
  wrapFile?: (file: FileItem, node: ReactNode) => ReactNode
  draggable: boolean
  /** Selection mode: the card is a toggle, `checked` says whether it is picked. */
  selecting: boolean
  checked: boolean
  onToggle: (documentId: string) => void
}

/**
 * One cell of the grid: the card and its menu.
 *
 * Memoised, and handed only stable functions by the workspace, so a pane that
 * re-renders (a poll patched one row, the reader typed, the preview opened
 * another file) re-renders the cells whose document or selection changed and
 * leaves the other few thousand alone.
 */
const FileTile = memo(function FileTile({
  file,
  isSelected,
  onSelectFile,
  locale,
  match,
  showAssignment,
  cardExtras,
  renderActions,
  wrapFile,
  draggable,
  selecting,
  checked,
  onToggle,
}: FileTileProps): ReactNode {
  const onSelect = useCallback(
    () => (selecting ? onToggle(file.id) : onSelectFile(file.id)),
    [selecting, onToggle, onSelectFile, file.id]
  )
  const card = (
    <FileCard
      file={file}
      isSelected={isSelected}
      onSelect={onSelect}
      locale={locale}
      match={match}
      footerLead={showAssignment ? <AssignmentFaces assignees={file.assignees} /> : undefined}
      {...cardExtras?.(file)}
      actions={renderActions?.(file)}
      draggable={draggable}
      selection={selecting ? { checked } : undefined}
    />
  )
  return wrapFile ? wrapFile(file, card) : card
})

/** The names a document's older Fassungen are stored under: what a search for them should find the document by. */
function olderRevisionNames(file: FileItem): string[] {
  const facts = file.revision
  if (!facts) return []
  return (facts.history ?? facts.supersedes).map((ref) => ref.filename)
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
  showOlderRevisions = false,
  search,
  view = 'cards',
  showAssignment = false,
  filterEmptyNotice,
  onDropDocumentInFolder,
  onDropFolderInFolder,
  onDropFilesInFolder,
  onFileAim,
  renderActions,
  cardExtras,
  wrapFile,
  wrapFileRow,
  onViewChange,
  onPickFiles,
  onPickFolder,
  sort = DEFAULT_FILE_SORT,
  onSortChange,
  brief,
  slice,
  paging,
  folderStats,
  shelfEmpty,
  searchMatchesNamesOnly = false,
  selection,
}: FileBrowserPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const { semantic } = search
  // The field answers every keystroke; the filter over the whole corpus, and
  // everything drawn from it, follows a beat behind and is dropped for a newer
  // keystroke. Typing stays immediate at five thousand documents.
  const query = useDeferredValue(search.query)

  // The level, ordered. The list view re-applies the identical sort to the rows
  // it is handed — a no-op, and cheaper than teaching every branch below which
  // of the two views it is about to render into.
  const orderedFiles = useMemo(() => sortFiles(files, sort, locale), [files, sort, locale])
  const levelDocumentIds = useMemo(() => files.map((file) => file.id), [files])
  const orderedSlice = useMemo(() => (slice ? sortFiles(slice.files, sort, locale) : []), [slice, sort, locale])

  // Client-side filter: name, plus AI tags, topics and summary when the backend
  // generated them. A typed query escapes the current folder (the query is the
  // context), so it runs over the corpus, not the level.
  const filteredFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orderedFiles
    // Both names, deliberately: somebody who renamed a document looks for what
    // they called it, and somebody who uploaded it looks for the file they sent.
    // The older Fassungen's names count too: a document is found by any name it
    // has been stored under, and its current entry is the one that answers.
    const matches = (searchFiles ?? files).filter(
      (f) =>
        documentDisplayName(f).toLowerCase().includes(q) ||
        f.filename.toLowerCase().includes(q) ||
        (f.summary ?? '').toLowerCase().includes(q) ||
        // A tag is found by what a person reads („Korrespondenz“), not its stored token.
        (f.tags ?? []).some((tag) => tagLabel(tag, t).toLowerCase().includes(q)) ||
        (f.topics ?? []).some((topic) => topic.toLowerCase().includes(q)) ||
        olderRevisionNames(f).some((name) => name.toLowerCase().includes(q))
    )
    return sortFiles(withoutOlderRevisions(matches, showOlderRevisions), sort, locale)
  }, [orderedFiles, files, searchFiles, query, sort, locale, showOlderRevisions, t])

  const currentFolderId = folderNav?.currentFolderId ?? null
  // A level the reader may only read offers no upload and no new folder
  // (ADR-0088); a notice says why. The server refuses either way.
  const writableHere = mayWriteAt(folderNav, currentFolderId)
  /**
   * Whether a document card lifts. Moving it out is a write where it is
   * (ADR-0088): in a read-only level the server would refuse it. And not while
   * a search is in force: the folders and the path, every place it could be
   * dropped, are hidden then, so a card that lifted had nowhere to go.
   */
  const liftable = Boolean(onDropDocumentInFolder) && writableHere && query.trim() === '' && !semantic.active
  const [createFolderIn, setCreateFolderIn] = useState<string | null | undefined>(undefined)
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)

  const touch = useCoarsePointer()
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
        // iOS Safari cannot pick a folder: the entry would open a plain file
        // picker, so a finger is not offered it.
        onUploadFolder: writableHere && !touch ? onPickFolder : undefined,
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
      touch,
      onViewChange,
      onSortChange,
    ],
  )

  const picking = selection?.active === true
  const toggleSelected = selection?.onToggle ?? noToggle
  const moveInSheet = useMoveInSheet()

  const fileCard = (file: FileItem, extra: { match?: FileCardProps['match'] } = {}) => (
    <FileTile
      file={file}
      isSelected={selectedFileId === file.id}
      onSelectFile={onSelectFile}
      locale={locale}
      match={extra.match}
      showAssignment={showAssignment}
      cardExtras={cardExtras}
      renderActions={renderActions}
      wrapFile={wrapFile}
      draggable={liftable}
      selecting={picking && !extra.match}
      checked={selection?.selectedIds.has(file.id) === true}
      onToggle={toggleSelected}
    />
  )

  const folderTile = (folder: FolderItem, asRow: boolean) => {
    const props = {
      folder,
      itemCount: folderItemCount(folder.id),
      lastModified: folderLastModified(folder.id),
      knowledge: folderAggregates.tallies.get(folder.id),
      onOpen: folderNav!.onNavigate,
      onRenameFolder: folderNav!.onRenameFolder,
      onDeleteFolder: folderNav!.onDeleteFolder,
      onDropDocument: onDropDocumentInFolder,
      onDropFolder: onDropFolderInFolder,
      canAcceptFolder,
      onDropFiles: onDropFilesInFolder,
      onFileAim,
      actions: folderNav ? (folderNav.readOnly ? <Fragment /> : <FolderActionsTrigger />) : undefined,
      editing: editingFolderId === folder.id,
      onEditingChange: (next: boolean) => setEditingFolderId(next ? folder.id : null),
      readOnly: folder.access === 'read',
    }
    const tile = asRow ? <FolderRow {...props} /> : <FolderCard {...props} />
    if (!folderNav || folderNav.readOnly) return tile
    return (
      <FolderObjectMenu
        folder={folder}
        folders={folderNav.folders}
        canAcceptMove={(target) => canMoveFolderTo(folder.id, target)}
        onOpen={() => folderNav.onNavigate(folder.id)}
        onNewInside={() => setCreateFolderIn(folder.id)}
        onRename={() => setEditingFolderId(folder.id)}
        onDescribe={
          folderNav.onDescribeFolder && folder.access !== 'read'
            ? () => folderNav.onDescribeFolder?.(folder.id)
            : undefined
        }
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
        moveInSheet={moveInSheet}
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
   * The derivation lives in {@link useLevelDirection} because the version that
   * did not — two refs written during render — was wrong in a way that only
   * showed up as "the animation goes the wrong way sometimes".
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
  /**
   * What the menu's „Verschieben" may pick: where it may go, and where the
   * reader may write (ADR-0088). A drag shows the second as a red, refusing
   * target instead (the target's `refusal`), so the reader learns why.
   */
  const canMoveFolderTo = useCallback(
    (draggedId: string, targetId: string | null) => canAcceptFolder(draggedId, targetId) && mayWriteAt(folderNav, targetId),
    [canAcceptFolder, folderNav]
  )

  /** The folders directly inside the current level — the drill-down tiles. */
  const childFolders = useMemo(
    () => (folderNav?.folders ?? []).filter((f) => f.parentId === currentFolderId),
    [folderNav?.folders, currentFolderId]
  )

  /**
   * What every folder card shows — its item count, the newest thing under it
   * and where its subtree stands with Piloti — for the WHOLE tree, in one pass.
   *
   * These were once functions called per rendered card, each re-scanning the
   * corpus, so a project with 500 documents and 30 folders paid that on every
   * keystroke and every poll. The subtree fold is `subtreeTallies`, shared with
   * the folder brief so a tile and the brief above it cannot disagree about
   * the same folder; the item count is direct children only and needs no walk.
   */
  const folderAggregates = useMemo((): {
    counts: ReadonlyMap<string, number>
    tallies: ReadonlyMap<string, KnowledgeTally>
  } => {
    // The server counted the whole shelf (ADR-0102): the rows on screen are
    // one level's first pages and would undercount every folder.
    if (folderStats) return folderStats
    // One entry per document, like the cards below the tiles: a folder holding
    // Index A, B and C of one drawing counts one item unless older Fassungen
    // are asked for (ADR-0099).
    const corpus = withoutOlderRevisions(searchFiles ?? files, showOlderRevisions)
    const allFolders = folderNav?.folders ?? []
    const counts = new Map<string, number>()
    const bump = (id: string | null | undefined) => {
      if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    for (const file of corpus) bump(file.folderId)
    for (const folder of allFolders) bump(folder.parentId)
    return { counts, tallies: subtreeTallies(corpus, allFolders) }
  }, [folderStats, files, searchFiles, folderNav?.folders, showOlderRevisions])

  /** Documents + subfolders directly inside `folderId`, for the count line. */
  const folderItemCount = (folderId: string): number => folderAggregates.counts.get(folderId) ?? 0

  /** Most recent child timestamp — the folder's "last change", like file cards show. */
  const folderLastModified = (folderId: string): string | null =>
    folderAggregates.tallies.get(folderId)?.latest ?? null

  if (isLoading) {
    return (
      <FileBrowserSkeleton view={view} withFolders={folderNav !== undefined} uploadCard={uploadCard} />
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
  const corpusEmpty = shelfEmpty ?? (searchFiles ?? files).length === 0
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
  const currentFolder =
    folderNav && currentFolderId ? (folderNav.folders.find((folder) => folder.id === currentFolderId) ?? null) : null
  const levelEmpty = files.length === 0 && childFolders.length === 0 && !paging?.hasMore

  // The end of a paged level or search: the next page when the reader gets there.
  const pagingFooter = paging ? (
    <LoadMore
      hasMore={paging.hasMore}
      loading={paging.loading}
      failed={paging.failed}
      onLoadMore={paging.onLoadMore}
      loadMoreLabel={t('browser.loadMore')}
      loadingLabel={t('browser.loadingMore')}
      failedLabel={t('browser.loadMoreFailed')}
    />
  ) : null

  return (
    // `phone:h-auto phone:min-h-full`: the breadcrumb row pins to the top of the
    // scroll container on a phone, and a sticky box only sticks inside its
    // parent. At `h-full` the parent is exactly one screen tall and the row
    // would let go after one screenful.
    <div className="flex h-full flex-col phone:h-auto phone:min-h-full">
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
          onCreateFolder={folderNav.readOnly ? undefined : folderNav.onCreateFolder}
          onDropDocument={onDropDocumentInFolder}
          onDropFolder={onDropFolderInFolder}
          canAcceptFolder={canAcceptFolder}
          onDropFiles={onDropFilesInFolder}
          onFileAim={onFileAim}
          mayWriteAt={(folderId) => mayWriteAt(folderNav, folderId)}
          readOnly={!writableHere}
        >
          {selection?.onStart && !picking && orderedFiles.length > 0 && writableHere && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={selection.onStart}
              data-testid="selection-start"
            >
              <CheckSquare className="size-4" aria-hidden />
              <span className="phone:sr-only">{t('selection.start')}</span>
            </Button>
          )}
        </FolderBreadcrumbRow>
      )}

      {/* What Piloti knows about the level's whole subtree. Hidden while a
          query runs for the same reason the breadcrumb is: the query is the
          context then, and its results span the corpus. */}
      {currentFolder && !semantic.active && !searching && (
        <div className={`${CONTENT_MAX} px-4 pt-3`}>
          <FolderDescriptionLine
            folder={currentFolder}
            canEdit={Boolean(folderNav?.onDescribeFolder) && writableHere}
            onEdit={() => folderNav?.onDescribeFolder?.(currentFolder.id)}
          />
        </div>
      )}
      {brief && !semantic.active && !searching && <div className={`${CONTENT_MAX} px-4 pt-4 phone:pt-2`}>{brief}</div>}
      {/* Piloti's filing suggestions for the documents of this level, one line
          per target folder, when one folder would collect two or more: the
          decision that moves several files, made where they are all in view. */}
      {!semantic.active && !searching && !slice && (
        <FilingViewBar documentIds={levelDocumentIds} className={`${CONTENT_MAX} px-4 pt-4`} />
      )}

      <ActionMenu mode="context" entries={listingEntries}>
      {semantic.active ? (
        // Semantic results — one card per matched file, each showing the match
        // evidence (snippet + page + relevance). A backend error/timeout fails
        // open to an empty result set (never a crash).
        semantic.isSearching ? (
          // Placeholders shaped like the view the answer will arrive in. Card
          // skeletons were drawn whatever the reader had chosen, so a search
          // from the list flashed a wall of tiles and then snapped to a table.
          view === 'list' ? (
            <div className={CONTENT_MAX}>
              <FileListSkeleton />
            </div>
          ) : (
            // The cap the answer will be drawn inside. Without it the running
            // search filled the full width and the results snapped to 1200px
            // under the reader the instant they arrived.
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
        filteredFiles.length === 0 && !paging?.hasMore && !paging?.loading ? (
          <div className="p-8">
            <EmptyState
              variant="bare"
              icon={Search}
              title={t('browser.noMatch', { query })}
              description={t(searchMatchesNamesOnly ? 'browser.noMatchNamesDescription' : 'browser.noMatchDescription')}
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
              selection={selection}
            />
            {pagingFooter}
          </div>
        ) : (
          <div className={`${CONTENT_MAX} p-4`}>
            <FileGrid>
              {filteredFiles.map((file) => (
                <Fragment key={file.id}>{fileCard(file)}</Fragment>
              ))}
            </FileGrid>
            {pagingFooter}
          </div>
        )
      ) : slice ? (
        /* A slice of the subtree the brief opened, flat — over every subfolder,
           like a search, and with the same views. */
        <div className={CONTENT_MAX} data-testid="folder-brief-slice">
          <div className="flex items-center gap-2 px-4 pt-4">
            <p className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{slice.label}</p>
            <Button type="button" variant="outline" size="sm" onClick={slice.onClear} data-testid="folder-brief-slice-clear">
              {t('brief.sliceClear')}
            </Button>
          </div>
          {slice.loading ? (
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
          ) : slice.files.length === 0 ? (
            <div className="p-8">
              <EmptyState variant="bare" icon={FolderOpen} title={t('brief.sliceEmpty')} />
            </div>
          ) : view === 'list' ? (
            <FileListView
              files={orderedSlice}
              selectedFileId={selectedFileId}
              onSelectFile={onSelectFile}
              renderActions={renderActions}
              wrapRow={wrapFileRow}
              sort={sort}
              onSortChange={onSortChange}
              selection={selection}
            />
          ) : (
            <div className="p-4">
              <FileGrid>
                {orderedSlice.map((file) => (
                  <Fragment key={file.id}>{fileCard(file)}</Fragment>
                ))}
              </FileGrid>
            </div>
          )}
        </div>
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
              // The folders are one connected run, not a stack of pills: the
              // `ItemList` rounds the outer corners and draws the hairlines.
              <div className="px-2 py-2" role="group" aria-label={t('folders.heading')}>
                <ItemList className="bg-muted/40">
                  {childFolders.map((folder) => (
                    <Fragment key={folder.id}>{folderTile(folder, true)}</Fragment>
                  ))}
                </ItemList>
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
                draggable={liftable}
                selection={selection}
              />
            )}
            {pagingFooter}
        </motion.div>
      ) : (
        <motion.div
          key={`grid-${currentFolderId ?? 'root'}`}
          {...levelTransition(navDirection, 20)}
          className={`${CONTENT_MAX} p-4`}
        >
            {/* Section label — "Recently uploaded" at the corpus root, matching
                the click-dummy. Hidden inside a folder (the breadcrumb already
                names it) and while searching (the query is the context). */}

            {/*
              ONE ENTRANCE FOR THE LEVEL, NOT ONE PER TILE.

              Every cell used to be wrapped in its own `motion.div` rising 10px
              on a per-index delay. Two things were wrong with that, and the
              second is the serious one.

              It compounded: the level was already sliding in sideways, so a
              navigation played N+1 animations at once, each tile drifting up
              through a container drifting across. And the delay was unbounded
              until it was capped, which put the last tile of a full Einreichung
              ten seconds out.

              The serious one is that motion writes `initial` into the SERVER's
              HTML. The listing is rendered on the server now, so every card
              shipped with `opacity: 0` and stayed invisible until the bundle
              booted and hydration released it — the exact wait the server
              render exists to remove, reintroduced as a blank grid over data
              that was already in the document.

              The level's own transition carries the whole grid, which is one
              animation, is what a Finder-style drill actually looks like, and
              renders at full opacity when nothing has navigated.
            */}
            <FileGrid className={FOLDER_ROWS_ON_PHONE}>
              {folderNav &&
                childFolders.map((folder) => (
                  <Fragment key={folder.id}>{folderTile(folder, false)}</Fragment>
                ))}
              {/* The label heads the FILES: it sat above the folder tiles and
                  promised recent uploads over a block of folders. A grid child
                  spanning the row, so it falls between the two. */}
              {currentFolderId === null && orderedFiles.length > 0 && (
                <SectionLabel as="p" className="col-span-full mt-1 font-semibold tracking-[0.05em] first:mt-0">
                  {t('browser.recentlyUploaded')}
                </SectionLabel>
              )}
              {orderedFiles.map((file) => (
                <Fragment key={file.id}>{fileCard(file)}</Fragment>
              ))}
              {/* A drop zone is a mouse affordance: there is no dragging a file
                  onto a phone, and the Hochladen button is under the thumb. */}
              {writableHere && !picking && uploadCard && <div className="contents pointer-coarse:hidden">{uploadCard}</div>}
            </FileGrid>
            {pagingFooter}
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
 * This was an `AnimatePresence mode="wait"`, and `wait` means exactly what it
 * says: the level you are leaving plays its exit to completion, and only then
 * does the level you asked for begin to appear. Two 180ms tweens end to end,
 * with a frame in the middle where the pane holds nothing and collapses to the
 * height of its own padding — on the gesture this page is built around, and one
 * a person repeats a dozen times walking a tree.
 *
 * Nothing needed the outgoing level to be watched on its way out. Dropping the
 * presence wrapper makes the swap instant and leaves the arrival, which is the
 * half that carries the direction: the new level slides in from the side it
 * came from, in one 240ms entrance, over content that is already there.
 *
 * `initial: false` when the direction is 0 — no navigation happened, so this is
 * the first paint (which, since the page now server-renders its listing, is a
 * real listing that must not slide) or a re-render the key did not change.
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
 * read, and it lives beside the listing rather than in a components-of-loading
 * file, because the failure it fixes is drift: the old skeleton drew a
 * full-width `h-9` bar — a search field that had moved into the page header a
 * release earlier and was never coming back — over a full-width grid, and then
 * the answer arrived as a breadcrumb row above a 1200px column of folder tiles
 * and cards. Nothing about the loading state predicted the loaded one, so every
 * load ended in a jump.
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
            <div className="px-2 py-2">
              <ItemList className="bg-muted/40">
                {Array.from({ length: folderCount }).map((_, index) => (
                  <FolderRowSkeleton key={index} />
                ))}
              </ItemList>
            </div>
          )}
          <FileListSkeleton rows={files} />
        </div>
      ) : (
        <div className={`${CONTENT_MAX} p-4`}>
          <Skeleton className="mb-3 h-3 w-36" />
          <FileGrid className={FOLDER_ROWS_ON_PHONE}>
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
 * The listing's width cap. With the tree band gone the browser owns the whole
 * column, and a 4K monitor would otherwise stretch cards into a wall — the
 * content centres inside the toolbars, which keep spanning the full width.
 */
const CONTENT_MAX = 'mx-auto w-full max-w-[1200px]'

const noToggle = (): void => undefined
