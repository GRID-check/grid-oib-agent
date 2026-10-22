'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { AlertCircle, Archive, Boxes, FileText, RotateCcw, X } from 'lucide-react'
import { sourceBase } from '@/lib/ui/source-tint'
import { cn } from '@/lib/utils'
import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useLocale, useTranslations } from '@/i18n'
import { createDocumentByNameClient } from '@/lib/documents/by-name-client'
import { documentDisplayName } from '@/lib/documents/display-name'
import { shelfSummaryUrl, type LevelPageRequest } from '@/lib/documents/level-client'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import type { LiveShelf } from '@/lib/documents/shelf-live-events'
import { offeredForRetry } from '@/lib/documents/retry-policy'
import { tagLabel } from '@/lib/documents/tag-vocabulary'
import { inferDocumentKind } from '../document-kind'
import type { FileItem, FolderItem } from '../file-types'
import { useDocParamSync, usePreviewChannel, type PreviewHandlers } from '../hooks/use-preview-channel'
import { useDocumentMoves } from '../hooks/use-document-moves'
import { useDocumentSelection } from '../hooks/use-document-selection'
import { usePhoneLayout } from '../hooks/use-phone-layout'
import { UploadFab } from './upload-fab'
import { useFileDragDrop, type DropInfo } from '../hooks/use-file-drag-drop'
import { isInternalDragActive, useFolderDropTarget, type FileDropAim } from '../hooks/use-document-drag'
import { useFileListing } from '../hooks/use-file-listing'
import { useFileSearch } from '../hooks/use-file-search'
import { useFolderParam } from '../hooks/use-folder-param'
import { useRootSortParam } from '../hooks/use-root-sort-param'
import { useFolderTree } from '../hooks/use-folder-tree'
import { useIngestionCompleteToast } from '../hooks/use-ingestion-complete-toast'
import { useLevelListing } from '../hooks/use-level-listing'
import { useLinkedDocuments } from '../hooks/use-linked-documents'
import { useModelStage } from '../hooks/use-model-stage'
import { useSettleTrackedUploads } from '../hooks/use-settle-tracked-uploads'
import { useShelfLive, type ShelfChange } from '../hooks/use-shelf-live'
import { useShelfSummary } from '../hooks/use-shelf-summary'
import { useShelfUpload } from '../hooks/use-shelf-upload'
import { useViewPreference } from '../hooks/use-view-preference'
import { useBriefCollapsed } from '../hooks/use-brief-collapsed'
import { useBulkReingest } from '../hooks/use-bulk-reingest'
import { useCompareParam } from '../hooks/use-compare-param'
import { useMissingDocuments } from '../hooks/use-missing-documents'
import { COMPARE_PARAM } from '../lib/revision-compare-link'
import {
  buildFolderBrief,
  buildFolderBriefFromSummary,
  selectInBrief,
  talliesFromSummary,
  type BriefSelection,
  type FolderBrief as FolderBriefData,
} from '../lib/folder-knowledge'
import type { DocumentWireRow } from '../lib/file-item'
import { LEVEL_SEARCH_DEBOUNCE_MS, levelSortOf, readFamiliesOf, readsWholeShelf } from '../lib/level-view'
import {
  NO_FILE_FILTERS,
  activeFilterCount,
  applyFileFilters,
  tagOptions as tagOptionsOf,
  type FileFilters,
} from '../lib/file-filters'
import type { FileShelf, FolderAccessLevel } from '../lib/file-shelf'
import { DEFAULT_FILE_SORT, type FileSort } from '../lib/file-sort'
import { DocumentActionsTrigger, DocumentObjectMenu, useMoveInSheet } from './document-actions'
import {
  DEFAULT_DOCUMENT_ACTIONS,
  READ_ONLY_DOCUMENT_ACTIONS,
  type DocumentActionKind,
} from './document-actions/action-entries'
import { FileBrowserPane } from './file-browser-pane'
import { InboundMailWaitingLine } from '@/features/inbound-mail/components/waiting-line'
import { FileDropOverlay, useWindowDragGuard } from './file-drop-overlay'
import { FileFilterMenu } from './file-filter-menu'
import { FilePreviewDialog } from './file-preview-dialog'
import { FolderBrief } from './folder-brief'
import { FolderPickerSheet } from './folder-picker-sheet'
import { RootSortDialog } from './root-sort/root-sort-dialog'
import type { RootSortShelf } from '@/lib/filing/root-sort-types'
import { SelectionBar } from './selection-bar'
import { withoutOlderRevisions } from '../lib/revision-chain'
import { sortedFolderDestinations } from '../lib/folder-path-label'
import { FilesHeaderControls } from './files-header-controls'
import { FolderAccessDialog } from './folder-access-dialog'
import { FolderDescriptionDialog } from './folder-description-dialog'
import { FilingSuggestionsProvider } from './filing-suggestion'
import { useFilingSuggestions } from '../hooks/use-filing-suggestions'
import type { ProposalListQuery } from '@/lib/proposals/types'
import { FolderUploadDialog } from './folder-upload-dialog'
import { ProjectUppyUpload } from './project-uppy-upload'
import { UploadTray } from './upload-tray'

/**
 * The building, full screen.
 *
 * `dynamic` with `ssr: false` because everything under it reaches for
 * `navigator.gpu` and, one boundary further down, a multi-megabyte WASM
 * geometry kernel. None of that belongs in the bundle of a page that is
 * usually opened to look at PDFs.
 */
const ModelStage = dynamic(
  () => import('@/features/bim/components/model-stage').then((module) => module.ModelStage),
  { ssr: false }
)

export interface FileWorkspaceProps {
  /** What differs between a project's Dateien and the office Archiv — see {@link FileShelf}. */
  shelf: FileShelf
  /**
   * Where the shelf's controls (view, filter, search, upload) go, and what
   * frames them: a project's section header, the Archiv's identity row.
   * `count` is the shelf's document count, null until it is known.
   */
  renderHeader: (controls: ReactNode, state: { count: number | null }) => ReactNode
  /**
   * More entries for the phone header's ⋯, after the view choice and the
   * Papierkorb: what a header carries as a button of its own on a wide screen
   * (a project's Outlook import) and cannot afford a button for on 393px.
   */
  moreEntries?: readonly ActionMenuEntry[]
  /**
   * The folder tree and the first page of a folder level as the SERVER already
   * read them, for the first paint (ADR-0102). `initialFiles` is the first
   * page of the level `initialFolderId` names (null: the root) in the default
   * order, newest first; `initialNextCursor` is where that level continues.
   * They seed state once, and only while the reader still stands on that
   * level; everything after goes through the same loaders.
   */
  initialFolders?: readonly FolderItem[]
  initialFiles?: readonly DocumentWireRow[]
  initialNextCursor?: string | null
  initialFolderId?: string | null
}

/** The ⋯ slot every card and row renders; the row's {@link DocumentObjectMenu} fills it. */
const renderDocumentActions = (): ReactNode => <DocumentActionsTrigger />

const NO_FILES: readonly FileItem[] = []
const NO_FOLDERS: readonly FolderItem[] = []

/** `first`, then every row of `second` it does not hold: one list for the lookups a link or a menu makes by id. */
function mergeById(first: readonly FileItem[], second: readonly FileItem[]): FileItem[] {
  const held = new Set(first.map((file) => file.id))
  return [...first, ...second.filter((file) => !held.has(file.id))]
}

/**
 * The file workspace of a shelf of documents — one component for a project's
 * Dateien and for the office Archiv.
 *
 * They were two components for as long as the Archiv was flat. Once it had
 * folders the choice was a second 1,600-line copy or one workspace that takes
 * its differences as data, and the copy would have been correct on the day it
 * was written and wrong a release later. Everything here is shared: one
 * loader, one folder tree, one move, one plan apply, one view/sort/filter
 * state, one search. Anything that must differ is a field of {@link FileShelf},
 * named and documented there.
 */
export function FileWorkspace({
  shelf,
  renderHeader,
  moreEntries,
  initialFolders,
  initialFiles,
  initialNextCursor = null,
  initialFolderId = null,
}: FileWorkspaceProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const { canManage, canCollaborate } = shelf
  const searchParams = useSearchParams()

  const [view, selectView] = useViewPreference()
  const [selectedFolderId, selectFolder] = useFolderParam()
  const [filters, setFilters] = useState<FileFilters>(NO_FILE_FILTERS)
  /**
   * Ordering is a question about the listing, not about how it is drawn, so it
   * is asked here and both views read it — the list's column headers write back
   * to this same state.
   */
  const [sort, setSort] = useState<FileSort>(DEFAULT_FILE_SORT)
  // The query lives here rather than in the browser pane: the field sits in the
  // header beside the view toggles while the results are rendered below.
  const search = useFileSearch(shelf.endpoints)
  // The name search is asked of the server once the reader stops typing; the
  // pane narrows what it holds at every keystroke meanwhile.
  const serverQuery = useDebouncedValue(search.query.trim(), LEVEL_SEARCH_DEBOUNCE_MS)

  /*
   * WHICH READ (ADR-0102). By default a folder LEVEL, page by page from the
   * server: the order, the name search, the status filter and the two server
   * filters are request parameters, and the folder tiles and the brief come
   * from the shelf summary. The whole shelf is drained into the browser only
   * for what the server cannot answer (`readsWholeShelf`: a kind, tag,
   * assignment or „Freigabe ausstehend“ filter, the status order), and when
   * the reader asks the brief for what Piloti put on the documents or opens
   * one of its slices (`detailsWanted`).
   */
  const wholeShelf = readsWholeShelf(filters, sort, canCollaborate)
  const [detailsWanted, setDetailsWanted] = useState(false)
  const pagedView = !wholeShelf

  // „Von Piloti" and „auch archivierte" are asked of the SERVER (a partial
  // index, and a default listing that does not contain them at all): every
  // read refetches on them instead of filtering what it has.
  const listing = useFileListing({
    endpoints: shelf.endpoints,
    agentAuthoredOnly: filters.agentAuthoredOnly,
    includeArchived: filters.includeArchived,
    enabled: wholeShelf || detailsWanted,
  })
  const shelfSummary = useShelfSummary({
    url: shelfSummaryUrl(shelf.endpoints, {
      agentAuthoredOnly: filters.agentAuthoredOnly,
      includeArchived: filters.includeArchived,
    }),
  })

  /*
   * Reloads reach the hooks below through refs, so the folder tree and the
   * upload plan (built before them) hold one stable function for the life of
   * the workspace.
   */
  const reloadFilesRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const reloadFiles = useCallback(() => reloadFilesRef.current(), [])
  const documentCountRef = useRef<(folderId: string) => number>(() => 0)
  const documentCountIn = useCallback((folderId: string) => documentCountRef.current(folderId), [])

  const tree = useFolderTree({
    foldersUrl: shelf.endpoints.folders,
    initialFolders,
    initialRootAccess: shelf.folderAccess?.initialRootAccess,
    files: listing.files,
    documentCountIn,
    selectedFolderId,
    onSelectFolder: selectFolder,
    reloadFiles,
    binHref: shelf.bin?.href,
  })
  const { folders } = tree

  // The level on screen. A failed folder read falls open to the whole shelf,
  // paged, instead of hiding every filed document; a search spans the shelf.
  const levelSort = levelSortOf(sort)
  const searchingServer = serverQuery !== ''
  const levelFolderId = searchingServer || tree.error ? undefined : selectedFolderId
  const levelRequest = useMemo((): Omit<LevelPageRequest, 'limit'> | null => {
    if (!pagedView || levelSort === null) return null
    return {
      list: shelf.endpoints.list,
      listParams: shelf.endpoints.listParams,
      folderId: levelFolderId,
      sort: levelSort,
      dir: sort.direction,
      q: searchingServer ? serverQuery : undefined,
      states: readFamiliesOf(filters.statuses),
      agentAuthoredOnly: filters.agentAuthoredOnly,
      includeArchived: filters.includeArchived,
    }
  }, [
    pagedView,
    levelSort,
    sort.direction,
    shelf.endpoints.list,
    shelf.endpoints.listParams,
    levelFolderId,
    searchingServer,
    serverQuery,
    filters.statuses,
    filters.agentAuthoredOnly,
    filters.includeArchived,
  ])
  // The server's first page answers the level the URL named at load, in the
  // default order with nothing filtered: exactly the first request, once.
  const [levelSeed] = useState(() =>
    initialFiles !== undefined && selectedFolderId === initialFolderId
      ? { rows: initialFiles, nextCursor: initialNextCursor }
      : undefined
  )
  const level = useLevelListing({
    request: levelRequest,
    resetKey: searchingServer ? 'search' : levelFolderId === undefined ? 'shelf' : `folder:${levelFolderId ?? 'root'}`,
    initialPage: levelSeed,
  })

  // The rows the pane draws, and the setter that patches them.
  const paneFiles = pagedView ? level.files : listing.files
  const collectionName = shelf.collectionName ?? level.collectionName ?? listing.collectionName

  // A link (`?doc=`, `?compare=`, the Archiv's `?model=`) to a document no
  // loaded page holds is read on its own.
  const byNameClient = useMemo(() => createDocumentByNameClient(), [])
  const resolveOfficeShelfByName = useCallback((name: string) => byNameClient.officeShelf([name]), [byNameClient])
  const loadedFiles = useMemo(
    () => (listing.files.length === 0 ? level.files : mergeById(level.files, listing.files)),
    [level.files, listing.files]
  )
  const linked = useLinkedDocuments({
    known: loadedFiles,
    ids: [searchParams?.get('doc'), searchParams?.get(COMPARE_PARAM)],
    byName:
      shelf.showModels && shelf.projectId === null
        ? { name: searchParams?.get('model')?.trim() || null, resolve: resolveOfficeShelfByName }
        : undefined,
  })
  const files = useMemo(
    () => (linked.files.length === 0 ? loadedFiles : [...loadedFiles, ...linked.files]),
    [loadedFiles, linked.files]
  )

  const { setFiles: setLevelFiles } = level
  const { setFiles: setListingFiles } = listing
  const { setFiles: setLinkedFiles } = linked
  /** Patch a row wherever it is held: the level, the drained shelf, a linked document. */
  const setFiles = useCallback<Dispatch<SetStateAction<FileItem[]>>>(
    (action) => {
      setLevelFiles(action)
      setListingFiles(action)
      setLinkedFiles(action)
    },
    [setLevelFiles, setListingFiles, setLinkedFiles]
  )

  const { reload: reloadLevel } = level
  const { reload: reloadSummary } = shelfSummary
  const { load: loadListing, reloadQuietly: reloadListingQuietly } = listing
  /** Read everything on screen again, quietly: the level, the counts, and the drain when it is on. */
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadLevel(true), reloadSummary(), loadListing(true)])
  }, [reloadLevel, reloadSummary, loadListing])
  // The upload's own settle signal, which asks often: each read replaces the
  // one before it, and the drain coalesces its own.
  const reloadQuietly = useCallback(() => {
    void reloadLevel(true)
    void reloadSummary()
    reloadListingQuietly()
  }, [reloadLevel, reloadSummary, reloadListingQuietly])
  useEffect(() => {
    reloadFilesRef.current = reloadAll
  }, [reloadAll])


  const upload = shelf.useUpload({
    collectionName,
    folderId: selectedFolderId ?? undefined,
    onComplete: reloadQuietly,
  })
  const { isUploading, error } = upload

  const moves = useDocumentMoves(files, setFiles, folders)
  const { moved: moveRow, dropInFolder: dropRowInFolder, moveMany, isMoving } = moves

  // Changes made anywhere else (a colleague, Piloti, the chat beside this,
  // another tab) arrive as a hint on the shelf's channel; what is on screen
  // is read again, quietly and coalesced (`reloadQuietly`, the upload's own
  // settle signal), and the folder tree when it moved too. Not while this
  // tab's own moves are on the wire: their echoes would put rows back that
  // are about to leave.
  const liveShelf = useMemo<LiveShelf>(
    () => (shelf.projectId ? { kind: 'project', projectId: shelf.projectId } : { kind: 'office_shelf' }),
    [shelf.projectId]
  )
  const { load: loadFolders } = tree
  const onShelfChanged = useCallback(
    (change: ShelfChange) => {
      reloadQuietly()
      if (change.folders) void loadFolders()
    },
    [reloadQuietly, loadFolders]
  )
  /*
   * Held while anything is being dragged, not only while a move is on the
   * wire: a re-read in the middle of a drag moves the tiles under the
   * pointer, and the document or file lands in whatever slid into place.
   */
  const fileDraggingRef = useRef(false)
  const folderMoving = tree.isMoving
  const holdLive = useCallback(
    () => isMoving() || folderMoving() || isInternalDragActive() || fileDraggingRef.current,
    [isMoving, folderMoving]
  )
  useShelfLive(liveShelf, onShelfChanged, { holdWhile: holdLive })
  // A move changes two folders' counts: the summary is read again after it.
  const moved = useCallback(
    (fileId: string, folderId: string | null) => {
      moveRow(fileId, folderId)
      void reloadSummary()
    },
    [moveRow, reloadSummary]
  )
  const dropInFolder = useCallback(
    async (documentId: string, folderId: string | null) => {
      await dropRowInFolder(documentId, folderId)
      void reloadSummary()
    },
    [dropRowInFolder, reloadSummary]
  )
  const shelfUpload = useShelfUpload({
    shelf,
    upload,
    folders,
    // Once the tree has answered. A re-read later (every live hint is one) must
    // not hold a drop back; a tree that never loaded must, or a dropped folder
    // is planned against no folders and lands in read-only ones.
    foldersReady: !tree.isFirstLoad && !tree.error,
    foldersSettled: !tree.isFirstLoad,
    selectedFolderId,
    loadFolders: tree.load,
    loadFiles: reloadFiles,
    uploading: isUploading,
  })
  const { handleUpload } = shelfUpload
  const access = useFolderAccess(shelf, folders, tree.rootAccess)
  const writableHere = access.mayWriteAt(selectedFolderId)

  const patchFile = useCallback(
    (fileId: string, patch: Partial<FileItem>) =>
      setFiles((prev) => (prev.some((f) => f.id === fileId) ? prev.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) : prev)),
    [setFiles]
  )

  /*
   * Patched, not refetched: each of these is durable the moment its request
   * returns, and the card, the list row and the preview header all read the
   * same `files` — they carry the change in the same frame the dialog closes.
   */
  /*
   * The preview opens ANOTHER document of this shelf by id (a Fassung in its
   * timeline). The handler is part of `handlers`, which the preview channel
   * takes, and the channel's `open` is built from `handlers`: so the handler
   * reaches `files` and `open` through refs and the object stays one value.
   */
  const filesRef = useRef(files)
  const openRef = useRef<(file: FileItem) => void>(() => undefined)
  const handlers = useMemo<PreviewHandlers>(
    () => ({
      onOpenDocument: (id) => {
        const file = filesRef.current.find((candidate) => candidate.id === id)
        if (file) openRef.current(file)
      },
      // A link was confirmed or taken back: the section reports BOTH documents of it.
      onRevisionChanged: (id, revision) => patchFile(id, { revision }),
      // After a successful re-ingestion the document is back to 'pending'; the
      // dead-end failure UI clears and the badge flips to "Processing".
      onReingested: (id, status) => patchFile(id, { status, errorMessage: null }),
      // The pane is reused across files and re-seeds from the tags on switch.
      onTagsUpdated: (id, tags, topics) => patchFile(id, topics === undefined ? { tags } : { tags, topics }),
      // A Freigabe decision moved the document's state; the panel has just
      // re-read the version list, so both numbers are the server's own.
      onLifecycleChanged: (id, summary: { versionState: DocumentVersionState; versionCount: number }) =>
        patchFile(id, summary),
      // The review read the marks or the reader changed them: the chip says
      // what the review says, not what the listing read before.
      onMarksChanged: (id, marks) => patchFile(id, { marks }),
      onDeleted: (id) => {
        setFiles((prev) => prev.filter((f) => f.id !== id))
        void reloadSummary()
      },
      onRenamed: (id, displayName) => patchFile(id, { displayName }),
    }),
    [patchFile, setFiles, reloadSummary]
  )

  const channel = usePreviewChannel(shelf, files, handlers)
  // `?compare=<older>` beside `?doc=`: the inbox's „Fassungen vergleichen“.
  // It decides the older one is missing once every linked id is answered, or
  // the whole drained listing is in.
  const compareElement = useCompareParam(files, linked.settled || (!pagedView && listing.complete))
  useEffect(() => {
    filesRef.current = files
    openRef.current = channel.open
  })
  const stage = useModelStage(shelf.showModels, files)

  /**
   * Open a file's preview. It does NOT touch the URL: `?doc=` has one writer,
   * the reconciler below, because the preview can also be opened from a link and
   * shut by three controls this function never hears about.
   *
   * An `.ifc` opens the way every other file opens: the preview first, with
   * the stage one button away.
   */
  const handleSelectFile = useCallback(
    (id: string | null) => {
      if (id === null) return channel.close()
      const file = files.find((candidate) => candidate.id === id)
      if (!file) return
      channel.open(file)
    },
    [files, channel]
  )
  // What the cards, rows and menus are handed: one function for the life of the
  // workspace, reaching the current `files` through a ref, so a memoised card is
  // not re-rendered because a poll changed some other row.
  const selectFileRef = useRef(handleSelectFile)
  useEffect(() => {
    selectFileRef.current = handleSelectFile
  }, [handleSelectFile])
  const selectFile = useCallback((id: string | null) => selectFileRef.current(id), [])
  useDocParamSync({
    openId: channel.openId,
    files,
    onUrlOpen: handleSelectFile,
    onUrlClose: channel.close,
  })

  useCompletionToast(paneFiles, shelf)
  useErrorToast(error)

  // Refetch what is on screen when an upload batch settles (covers
  // non-orchestrated paths). Quietly, like `onComplete`: the grid is on screen.
  const wasUploading = useRef(false)
  useEffect(() => {
    if (wasUploading.current && !isUploading) reloadQuietly()
    wasUploading.current = isUploading
  }, [isUploading, reloadQuietly])

  // This session's own uploads for this shelf's corpus, in every phase, so the
  // tray carries a batch from queued to its summary. `file` being present marks
  // a row as ours: server-loaded documents belong in the browser, never the tray.
  const activeUploads = useMemo(
    () => upload.trackedFiles.filter((f) => f.collectionName === collectionName && f.file != null),
    [upload.trackedFiles, collectionName]
  )
  // Settles the tray rows no ingest job will — a detached extraction (`.ifc`, an
  // office file read from its PDF rendition).
  useSettleTrackedUploads(paneFiles, activeUploads)

  // Piloti's filing suggestions for this shelf, on the file rows and the tray's
  // rows. Asked again every few seconds while an upload is on screen: the
  // judgement from the names runs as soon as the batch is sealed.
  const filingQuery = useMemo<ProposalListQuery>(
    () => (shelf.projectId ? { projectId: shelf.projectId } : { shelf: 'office_shelf' }),
    [shelf.projectId]
  )
  const filing = useFilingSuggestions({ query: filingQuery, refreshKey: files.length, watching: activeUploads.length > 0 })
  const { reload: reloadFiling } = filing
  const onFilingSettled = useCallback(() => {
    void reloadAll()
    reloadFiling()
  }, [reloadAll, reloadFiling])
  // Where a document is now, for the before line of a suggestion's popover:
  // its folder's path, '' at the top level, unknown for a row no page holds.
  const folderPathOf = useMemo(() => {
    const folderOf = new Map(files.map((file) => [file.id, file.folderId ?? null]))
    const pathOf = new Map(folders.map((folder) => [folder.id, folder.path]))
    return (documentId: string): string | undefined => {
      const folderId = folderOf.get(documentId)
      if (folderId === undefined) return undefined
      return folderId === null ? '' : pathOf.get(folderId)
    }
  }, [files, folders])
  /** The folder whose description is being written (migration 0145). */
  const [describingFolderId, setDescribingFolderId] = useState<string | null>(null)

  // A level the reader may only read (ADR-0088) takes no dropped files, and
  // says so while they are dragged over it rather than swallowing them. A drop
  // while an upload runs is no longer refused: `useShelfUpload` queues it.
  const onDroppedHere = useCallback(
    (dropped: File[], info: DropInfo) => handleUpload(dropped, { info }),
    [handleUpload]
  )
  const { isDragging, isUnsupportedDrag, refusal: dropRefusal, dragHandlers } = useFileDragDrop({
    onDrop: onDroppedHere,
    disabled: !canManage,
    refusal: writableHere ? null : t('workspace.dropRefusedHere'),
    acceptZip: true,
  })
  useEffect(() => {
    fileDraggingRef.current = isDragging
  }, [isDragging])
  /** The folder tile or way up the desktop files hover, which the overlay names. */
  const [fileAim, setFileAim] = useState<FileDropAim | null>(null)
  useEffect(() => {
    if (!isDragging) setFileAim(null)
  }, [isDragging])
  const dropFilesInFolder = useCallback(
    (dropped: File[], info: DropInfo, folderId: string | null) => handleUpload(dropped, { folderId, info }),
    [handleUpload]
  )
  const folderNameOf = (folderId: string | null): string =>
    folderId === null ? t('folders.allFiles') : (folders.find((folder) => folder.id === folderId)?.name ?? '')
  // Where the drop lands, named: the tile under the pointer, or the folder on
  // screen. „In dieses Projekt" said nothing about which folder a drop in a
  // search result, or three levels down, would land in.
  const dropTargetLabel = fileAim
    ? t('workspace.dropInto', { name: folderNameOf(fileAim.folderId) })
    : selectedFolderId !== null && folderNameOf(selectedFolderId)
      ? t('workspace.dropInto', { name: folderNameOf(selectedFolderId) })
      : shelf.messages.dropToUpload
  useWindowDragGuard()

  /**
   * The level on screen is a target for a document or folder that is not
   * already in it. A drag held over a folder opens it (`onSpringOpen` on the
   * tiles and the path), and the release then lands on this level's
   * background, not on a tile: without this it did nothing. On its own level
   * it is still refused, so a document let go between two tiles is not a move.
   * Not while a search is in force: its results span the shelf.
   */
  const levelDrop = useFolderDropTarget({
    folderId: selectedFolderId,
    onDropDocument: (documentId, folderId) => void dropInFolder(documentId, folderId),
    onDropFolder: (folderId, parentId) => void tree.move(folderId, parentId),
    disabled: !canManage || search.query.trim() !== '' || search.semantic.active,
    refusal: writableHere ? null : t('workspace.dropRefusedHere'),
    onlyFromElsewhere: true,
  })
  /** Both on the one surface: each answers its own kind of drag and passes the other through. */
  const surfaceDragHandlers = {
    onDragEnter: dragHandlers.onDragEnter,
    onDragOver: (event: React.DragEvent) => {
      levelDrop.dropProps.onDragOver(event)
      dragHandlers.onDragOver(event)
    },
    onDragLeave: (event: React.DragEvent) => {
      levelDrop.dropProps.onDragLeave(event)
      dragHandlers.onDragLeave(event)
    },
    onDrop: (event: React.DragEvent) => {
      levelDrop.dropProps.onDrop(event)
      dragHandlers.onDrop(event)
    },
  }

  // The status filter is the server's on a paged level; asking it again of
  // the rows that came back is the same answer, and keeps a row whose status
  // changed since in step with the chip.
  const filteredFiles = useMemo(
    () => applyFileFilters(paneFiles, filters, { canCollaborate, currentUserId: shelf.currentUserId }),
    [paneFiles, filters, canCollaborate, shelf.currentUserId]
  )
  // One entry per document: an older Fassung leaves the listing when its newer
  // one is listed (`isOlderRevision`). Asked after the other filters, over what
  // they kept, so an older one whose newer one a filter hid stays visible. On a
  // paged level it is asked of the pages read so far: which document replaces
  // which is a link in the backend's index, not a column the server could
  // leave a row out by (ADR-0099, ADR-0102). The search runs on
  // `filteredFiles` and applies the same rule to its own matches in the pane.
  const listedFiles = useMemo(
    () => withoutOlderRevisions(filteredFiles, filters.showOlderRevisions),
    [filteredFiles, filters.showOlderRevisions]
  )
  // The rows of the level on screen. A paged level already is one, and the
  // filter keeps a row moved out of it from lingering until the next read.
  const levelFiles = useMemo(
    () =>
      tree.error
        ? listedFiles
        : listedFiles.filter((file) => (file.folderId ?? null) === selectedFolderId),
    [listedFiles, selectedFolderId, tree.error]
  )
  const tagOptions = useMemo(
    () => tagOptionsOf(paneFiles, locale, (tag) => tagLabel(tag, t)),
    [paneFiles, locale, t]
  )

  // What the server counted for the whole shelf: the folder tiles, the header
  // count, the brief and the delete confirmation read it on a paged level.
  const summaryTallies = useMemo(
    () => (shelfSummary.summary ? talliesFromSummary(shelfSummary.summary, folders) : null),
    [shelfSummary.summary, folders]
  )
  const folderStats = useMemo(() => {
    if (!pagedView || !summaryTallies) return undefined
    const counts = new Map<string, number>()
    for (const [id, tally] of summaryTallies.direct) {
      if (id !== null) counts.set(id, tally.total)
    }
    for (const folder of folders) {
      if (folder.parentId !== null) counts.set(folder.parentId, (counts.get(folder.parentId) ?? 0) + 1)
    }
    return { counts, tallies: summaryTallies.subtree }
  }, [pagedView, summaryTallies, folders])
  useEffect(() => {
    documentCountRef.current = (folderId) =>
      summaryTallies
        ? (summaryTallies.direct.get(folderId)?.total ?? 0)
        : files.filter((file) => file.folderId === folderId).length
  })

  // The brief: built from the drained shelf once it is in, else from the
  // summary (counts only, `partial`), else, when the summary could not be
  // read, from the rows loaded so far.
  const corpusReady = (wholeShelf || detailsWanted) && listing.complete && !listing.isLoading && !listing.error
  const briefFolders = tree.error ? NO_FOLDERS : folders
  const briefData = useMemo((): FolderBriefData | null => {
    if (corpusReady) return buildFolderBrief(listing.files, briefFolders, selectedFolderId)
    if (shelfSummary.summary) return buildFolderBriefFromSummary(shelfSummary.summary, briefFolders, selectedFolderId)
    if (shelfSummary.error) return buildFolderBrief(paneFiles, briefFolders, selectedFolderId)
    return null
  }, [corpusReady, listing.files, shelfSummary.summary, shelfSummary.error, paneFiles, briefFolders, selectedFolderId])
  const requestDetails = useCallback(() => setDetailsWanted(true), [])
  const briefSurface = useFolderBriefSurface({
    shelf,
    brief: briefData,
    folders: briefFolders,
    selectedFolderId,
    onOpenFolder: selectFolder,
    onReingested: handlers.onReingested,
    onReadAgainDone: reloadSummary,
    onRequestDetails: requestDetails,
    detailsLoading: (wholeShelf || detailsWanted) && !corpusReady,
    mayReadAgain: canManage && writableHere,
  })

  // Whether the level holds documents before the client-side filters: on a
  // paged level the summary knows, the rows loaded so far do not.
  const levelKey = tree.error ? null : selectedFolderId
  const levelOccupied =
    pagedView && summaryTallies
      ? tree.error
        ? summaryTallies.total > 0
        : (summaryTallies.direct.get(levelKey)?.total ?? 0) > 0
      : tree.error
        ? paneFiles.length > 0
        : paneFiles.some((file) => (file.folderId ?? null) === selectedFolderId)
  const filterEmptyNotice = useFilterEmptyNotice({
    filters,
    setFilters,
    canCollaborate,
    search,
    levelFiles,
    levelOccupied,
  })

  const shelfCount = pagedView
    ? (summaryTallies?.total ?? null)
    : listing.isLoading || listing.error || !listing.complete
      ? null
      : listing.files.length
  const listingError = pagedView ? level.error : listing.error
  const retryListing = pagedView ? () => void level.reload(false) : () => void listing.load()

  /*
   * PICKING SEVERAL (phone first). „Auswählen" turns a press on a card or row
   * into a pick and the foot of the listing into a bar: five site photos go to
   * their folder in three taps instead of five trips through a menu. It is a
   * mode of ONE level, so walking elsewhere, searching or opening a slice of
   * the brief ends it.
   */
  const phone = usePhoneLayout()
  const moveInSheet = useMoveInSheet()
  const selection = useDocumentSelection()
  const { exit: exitSelection, set: setSelection, start: startSelection } = selection
  const [moveSheetOpen, setMoveSheetOpen] = useState(false)
  const [rootSortOpen, setRootSortOpen] = useState(false)
  const searchingNow = search.query.trim() !== '' || search.semantic.active
  const sliceOpen = briefSurface.slice !== undefined
  useEffect(() => {
    exitSelection()
  }, [selectedFolderId, searchingNow, sliceOpen, exitSelection])
  const mayPick = canManage && writableHere
  const pickable = useMemo(() => levelFiles.map((file) => file.id), [levelFiles])
  const moveSelection = async (folderId: string | null, folderName: string): Promise<void> => {
    setMoveSheetOpen(false)
    const ids = [...selection.selectedIds]
    exitSelection()
    await moveMany(ids, folderId, folderName)
    void reloadSummary()
  }

  const pickFilesRef = useRef<(() => void) | null>(null)
  const pickFolderRef = useRef<(() => void) | null>(null)
  // No upload into a level the reader may only read (ADR-0088).
  const uploader = (props: Partial<Parameters<typeof ProjectUppyUpload>[0]>) =>
    canManage && writableHere ? (
      <ProjectUppyUpload
        folderId={selectedFolderId}
        onUpload={handleUpload}
        isUploading={isUploading}
        onSendByMail={shelf.inboundMail?.openAddress}
        {...props}
      />
    ) : undefined

  // Sorting the root moves its files into folders: a writer of the root may run it, as may anyone who may move a file there.
  const mayRootSort = canManage && access.mayWriteAt(null)
  const rootSortShelf = useMemo<RootSortShelf>(
    () => (shelf.projectId ? { kind: 'project', projectId: shelf.projectId } : { kind: 'office_shelf' }),
    [shelf.projectId]
  )
  // An inbox row that says the sort is ready opens its dialog (`?rootSort=<runId>`).
  const openRootSort = useCallback(() => setRootSortOpen(true), [])
  useRootSortParam(mayRootSort, openRootSort)
  const advancedEntries: ActionMenuEntry[] | undefined = mayRootSort
    ? [
        { type: 'label', label: t('rootSort.advanced') },
        {
          type: 'item',
          id: 'root-sort',
          label: t('rootSort.menuItem'),
          onSelect: () => setRootSortOpen(true),
          testId: 'root-sort-trigger',
        },
      ]
    : undefined

  const controls = (
    <FilesHeaderControls
      phone={phone}
      view={view}
      onViewChange={selectView}
      binHref={shelf.bin?.href}
      openPointsHref={shelf.openPoints?.href}
      inboundMail={shelf.inboundMail ? { href: shelf.inboundMail.href, waiting: shelf.inboundMail.waiting } : undefined}
      renderFilter={(compact) => (
        <FileFilterMenu
          canCollaborate={canCollaborate}
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
          // A ranked result set orders itself; offering a column here would throw
          // the ranking away without saying so.
          sortDisabled={search.semantic.active}
          tagOptions={tagOptions}
          compact={compact}
        />
      )}
      // The corpus search, in the header with the other controls that act on the
      // listing. No run button: the field reads as the plain filter it mostly is,
      // and Enter commits the query to the semantic search.
      search={{ value: search.query, onChange: search.setQuery, onSubmit: search.run, onClear: search.clear }}
      // The durable corpus is where a büro brings a whole tree in. On a phone the
      // same control floats at the foot of the screen instead (`uploadFab`).
      upload={phone ? undefined : uploader({ allowFolders: true, pickFilesRef, pickFolderRef })}
      moreEntries={moreEntries}
      advancedEntries={advancedEntries}
    />
  )

  /*
   * The phone's Hochladen: the ONE upload control (a second instance would be a
   * second hidden input and a second owner of the pick refs), moved from the
   * header to the foot of the listing, in the thumb's reach. It is the same
   * component, so whatever the uploader offers in its menu is here too. Hidden
   * while picking: the selection bar owns the foot then. The workspace is the
   * positioned ancestor, so the button rides above the phone's in-flow tab bar
   * with no height to guess.
   */
  const inSheet = shelf.source === 'office'
  const uploadFab =
    phone && !selection.active ? uploader({ allowFolders: true, pickFilesRef, pickFolderRef }) : undefined

  /*
   * One menu per card and row, built lazily (`DocumentObjectMenu`) and handed
   * only stable values, so the memoised tiles in the pane re-render when THEIR
   * document changed and not when anything at all did. The move targets are
   * labelled and sorted once per tree here, not once per row.
   */
  const folderDestinations = useMemo(() => sortedFolderDestinations(folders), [folders])
  const { documentActionsAt } = access
  const { askAbout, documentScope } = shelf
  const objectMenu = useCallback(
    (file: FileItem, node: ReactNode, asChild: boolean) => (
      <DocumentObjectMenu
        asChild={asChild}
        document={file}
        scope={documentScope}
        canManage={canManage}
        actions={documentActionsAt(file.folderId)}
        destinations={folderDestinations}
        onOpen={() => selectFile(file.id)}
        onAsk={askAbout ? () => askAbout(file) : undefined}
        onRenamed={handlers.onRenamed}
        onDeleted={handlers.onDeleted}
        onMoved={moved}
        onReingested={handlers.onReingested}
        onSelectMode={mayPick ? () => startSelection(file.id) : undefined}
        moveInSheet={moveInSheet}
      >
        {node}
      </DocumentObjectMenu>
    ),
    [
      documentScope,
      canManage,
      documentActionsAt,
      folderDestinations,
      selectFile,
      askAbout,
      handlers,
      moved,
      mayPick,
      startSelection,
      moveInSheet,
    ]
  )
  const wrapFile = useCallback((file: FileItem, card: ReactNode) => objectMenu(file, card, false), [objectMenu])
  const wrapFileRow = useCallback((file: FileItem, row: ReactNode) => objectMenu(file, row, true), [objectMenu])

  return (
    <FilingSuggestionsProvider
      byDocument={filing.byDocument}
      byFolder={filing.byFolder}
      onSettled={onFilingSettled}
      folderPathOf={folderPathOf}
    >
    <div className="relative flex h-full flex-col" {...(canManage ? surfaceDragHandlers : {})} data-testid="workspace-dropzone">
      <FileDropOverlay
        show={canManage && isDragging}
        isUnsupported={isUnsupportedDrag}
        uploadLabel={dropTargetLabel}
        unsupportedLabel={t('workspace.dropUnsupported')}
        refusal={fileAim ? fileAim.refusal : dropRefusal}
        testId="workspace-drop-overlay"
      />

      {/* The count is a claim about the whole shelf: the summary's on a paged
          level, the drained listing's once its last page is in. */}
      {renderHeader(controls, { count: shelfCount })}

      {error && (
        <div className="border-b px-4 py-3 animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>{t('workspace.uploadProblem')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 size-6"
              onClick={upload.clearError}
              aria-label={t('workspace.dismissError')}
            >
              <X className="size-4" />
            </Button>
          </Alert>
        </div>
      )}

      <UploadTray
        files={activeUploads}
        onRetry={upload.retryFile}
        onCancel={upload.cancelFile}
        onCancelAll={upload.cancelUpload}
        onDismiss={upload.dismissFiles}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Folder listing failed: say so once, above a browser that falls open
            to the whole corpus, instead of hiding every filed document. */}
        {tree.error && (
          <div className="border-b px-4 py-2">
            <PaneLoadError message={t('workspace.foldersLoadError')} onRetry={tree.load} inline />
          </div>
        )}
        {/* The drain hit its ceiling: say which documents are missing rather
            than let search, filters and the upload plan pretend to be whole. */}
        {!pagedView && listing.truncated && (
          <div className="border-b px-4 py-2">
            <Alert>
              <AlertCircle className="size-4" />
              <AlertDescription>{t('workspace.listTruncated', { count: listing.files.length })}</AlertDescription>
            </Alert>
          </div>
        )}

        {/* Mail waiting in the E-Mail-Eingang, said once above the root of the shelf. */}
        {shelf.inboundMail && selectedFolderId === null && (shelf.inboundMail.waiting ?? 0) > 0 && (
          <div className="border-b px-4 py-2">
            <InboundMailWaitingLine href={shelf.inboundMail.href} count={shelf.inboundMail.waiting ?? 0} more={shelf.inboundMail.more} />
          </div>
        )}

        {/* On a phone the Hochladen button floats over the foot of the list, so
            the list ends the button's height plus its 1rem offset and a 1rem gap (6rem) above the screen's edge: the last
            card is never under it. */}
        <div
          className={cn(
            'scroll-fade-bottom min-h-0 min-w-0 flex-1 overflow-y-auto',
            // The Archiv is a sheet over the shell: it reaches the screen's
            // edge, so its list ends above the home indicator. A project's
            // Dateien sits above the in-flow tab bar, which owns that inset.
            inSheet && !uploadFab && 'pb-[env(safe-area-inset-bottom)]',
            uploadFab && (inSheet ? 'pb-[calc(6rem+env(safe-area-inset-bottom))]' : 'pb-24')
          )}
        >
          {listingError ? (
            <PaneLoadError message={t('workspace.documentsLoadError')} onRetry={retryListing} />
          ) : (
            <FileBrowserPane
              files={levelFiles}
              searchFiles={filteredFiles}
              showOlderRevisions={filters.showOlderRevisions}
              selectedFileId={channel.openId}
              onSelectFile={selectFile}
              // A skeleton only while there is nothing to show: a reload of the
              // listing or the tree keeps what is on screen until it lands.
              isLoading={(pagedView ? level.isLoading : listing.isLoading) || tree.isFirstLoad}
              {...(pagedView
                ? {
                    paging: {
                      hasMore: level.hasMore,
                      loading: level.isLoadingMore,
                      failed: level.moreError,
                      onLoadMore: level.loadMore,
                    },
                    folderStats,
                    shelfEmpty: summaryTallies ? summaryTallies.total === 0 : undefined,
                    searchMatchesNamesOnly: true,
                  }
                : {})}
              search={search}
              view={view}
              onViewChange={selectView}
              sort={sort}
              onSortChange={setSort}
              showAssignment={canCollaborate}
              filterEmptyNotice={filterEmptyNotice}
              onDropDocumentInFolder={canManage ? dropInFolder : undefined}
              onDropFolderInFolder={canManage ? tree.move : undefined}
              onDropFilesInFolder={canManage ? dropFilesInFolder : undefined}
              onFileAim={setFileAim}
              onPickFiles={canManage ? () => pickFilesRef.current?.() : undefined}
              onPickFolder={canManage ? () => pickFolderRef.current?.() : undefined}
              cardExtras={shelf.cardExtras}
              wrapFile={wrapFile}
              wrapFileRow={wrapFileRow}
              renderActions={renderDocumentActions}
              {...(tree.error
                ? {}
                : {
                    folderNav: {
                      folders,
                      currentFolderId: selectedFolderId,
                      onNavigate: selectFolder,
                      onCreateFolder: tree.create,
                      onRenameFolder: tree.rename,
                      onDeleteFolder: tree.remove,
                      readOnly: !canManage,
                      onDescribeFolder: canManage ? setDescribingFolderId : undefined,
                      ...access.folderNav,
                    },
                  })}
              uploadControl={uploader({
                variant: 'default',
                size: 'default',
                label: t('workspace.uploadDocuments'),
              })}
              uploadCard={uploader({ variant: 'dropcard' })}
              brief={briefSurface.brief}
              slice={briefSurface.slice}
              selection={
                mayPick
                  ? {
                      active: selection.active,
                      selectedIds: selection.selectedIds,
                      onToggle: selection.toggle,
                      onStart: sliceOpen ? undefined : () => startSelection(),
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>

      {selection.active && (
        <SelectionBar
          count={selection.selectedIds.size}
          total={pickable.length}
          canMove={folderDestinations.length > 0}
          onSelectAll={() => setSelection(pickable)}
          onMove={() => setMoveSheetOpen(true)}
          onDone={exitSelection}
        />
      )}
      {uploadFab && <UploadFab inSheet={inSheet}>{uploadFab}</UploadFab>}
      <FolderPickerSheet
        open={moveSheetOpen}
        onOpenChange={setMoveSheetOpen}
        title={t('picker.titleMany', { count: selection.selectedIds.size })}
        destinations={folderDestinations}
        // A level's documents all stand in the folder the reader is in.
        currentFolderId={tree.error ? undefined : selectedFolderId}
        onPick={(folderId, folderName) => void moveSelection(folderId, folderName)}
      />

      {/* „Wollen Sie aktualisieren?" — the plan a dropped folder opens, before
          anything moves. Rendered unconditionally so its own exit transition
          runs; `open` is what decides. */}
      <FolderUploadDialog
        open={shelfUpload.decision.open}
        onOpenChange={shelfUpload.decision.setOpen}
        plan={shelfUpload.decision.plan}
        currentFolderName={
          selectedFolderId ? (folders.find((folder) => folder.id === selectedFolderId)?.name ?? null) : null
        }
        onConfirm={shelfUpload.applyFolderPlan}
        pending={shelfUpload.decision.pending}
        kind={shelfUpload.decision.kind}
        onReleaseChange={shelfUpload.onReleaseChange}
        onRevisionChange={shelfUpload.onRevisionChange}
      />

      {/* What belongs in a folder (migration 0145), on both shelves. */}
      <FolderDescriptionDialog
        folder={folders.find((folder) => folder.id === describingFolderId) ?? null}
        onOpenChange={(next) => !next && setDescribingFolderId(null)}
        onSave={tree.describe}
      />

      {/* Who may read and write a folder (ADR-0088), a project's only. Saving
          moves and re-reads the folder's documents, so both listings are read
          again. */}
      {mayRootSort && (
        <RootSortDialog
          shelf={rootSortShelf}
          open={rootSortOpen}
          onOpenChange={setRootSortOpen}
          onApplied={() => void reloadAll()}
        />
      )}

      {shelf.folderAccess && (
        <FolderAccessDialog
          open={access.editingFolderId !== null}
          onOpenChange={(next) => !next && access.setEditingFolderId(null)}
          projectId={shelf.folderAccess.projectId}
          folder={folders.find((folder) => folder.id === access.editingFolderId) ?? null}
          onSaved={() => {
            void tree.load()
            void reloadAll()
          }}
        />
      )}

      {shelf.preview.kind === 'dialog' && (
        <FilePreviewDialog
          file={channel.dialogFile}
          canManage={canManage}
          scope={shelf.documentScope}
          onClose={channel.close}
          showModels={shelf.showModels}
          onReingested={handlers.onReingested}
          onTagsUpdated={handlers.onTagsUpdated}
          onOpenDocument={handlers.onOpenDocument}
          onRevisionChanged={handlers.onRevisionChanged}
          onMarksChanged={handlers.onMarksChanged}
          onRenamed={handlers.onRenamed}
          onDeleted={handlers.onDeleted}
        />
      )}

      {/* The model, when the URL names one — full screen inside a popup, so the
          page it opened from is still visible at the edges. A project resolves
          the file by name itself; the office Archiv has no project to resolve
          it in, so it needs the document the listing already holds. */}
      {stage.stageModel && (shelf.projectId !== null || stage.stageDocument) && (
        <ModelStage
          projectId={shelf.projectId}
          documentId={stage.stageDocument?.id}
          onClose={stage.closeModel}
          // The viewport carries the same file operations as every other
          // document surface, so its renames and deletions have to land in this
          // page's corpus — or closing the stage reveals a stale grid.
          onModelRenamed={handlers.onRenamed}
          onModelDeleted={handlers.onDeleted}
          canCollaborate={canCollaborate}
        />
      )}

      {compareElement}
    </div>
    </FilingSuggestionsProvider>
  )
}

/**
 * The folder brief and the slice of the subtree it opens, for the level the
 * reader stands on.
 *
 * Built from the UNFILTERED shelf: the brief describes the folder, and a
 * filter that hides half of it must not make Piloti appear to know half as
 * much. The caller builds it (ADR-0102): from the drained shelf once it is in
 * (`buildFolderBrief`, one entry per document, ADR-0099), else from the shelf
 * summary (`buildFolderBriefFromSummary`, counts only and `partial`). A
 * partial brief offers to load what Piloti put on the documents, and a slice
 * it opens asks for the same, because a slice is drawn from the documents the
 * brief counted: a chip that says „Grundriss 12“ opens twelve documents.
 */
function useFolderBriefSurface({
  shelf,
  brief,
  folders,
  selectedFolderId,
  onOpenFolder,
  onReingested,
  onReadAgainDone,
  onRequestDetails,
  detailsLoading,
  mayReadAgain,
}: {
  shelf: FileShelf
  brief: FolderBriefData | null
  folders: readonly FolderItem[]
  selectedFolderId: string | null
  onOpenFolder: (id: string | null) => void
  onReingested: (id: string, status: string) => void
  /** The counts changed: the summary is read again. */
  onReadAgainDone: () => void
  /** Read the whole shelf, for a partial brief's content facts and its slices. */
  onRequestDetails: () => void
  detailsLoading: boolean
  mayReadAgain: boolean
}) {
  const t = useTranslations('files')
  const [collapsed, setCollapsed] = useBriefCollapsed(usePhoneLayout())
  const [selection, setSelection] = useState<{ folderId: string | null; selection: BriefSelection } | null>(null)
  const bulk = useBulkReingest(onReingested)
  const missing = useMissingDocuments(shelf.projectId)
  const folderName = selectedFolderId
    ? (folders.find((folder) => folder.id === selectedFolderId)?.name ?? null)
    : null
  const partial = brief?.partial === true

  // A slice belongs to the folder it was opened in; walking elsewhere drops it.
  const active = selection && selection.folderId === selectedFolderId ? selection.selection : null

  const failedIds = brief?.attention.failed
  const readAgain = useCallback(async () => {
    // Only what reading again may change: a file that failed for a lasting
    // reason is left out, as the button's count already says.
    const ids = offeredForRetry(failedIds ?? []).map((file) => file.id)
    const result = await bulk.run(ids)
    const started = result.done - result.failed - (result.unchanged ?? 0)
    if (started > 0) toast.success(t('brief.readAgainDone', { count: started }))
    if (result.failed > 0) toast.error(t('brief.readAgainPartial', { count: result.failed }))
    onReadAgainDone()
  }, [failedIds, bulk, t, onReadAgainDone])

  const sliceLabel = (current: BriefSelection): string => {
    const what =
      current.kind === 'tag'
        ? current.tag
        : current.kind === 'topic'
          ? current.topic
          : current.kind === 'state'
            ? t(`brief.slice.${current.state}`)
            : t(`brief.slice.${current.kind}`)
    const where = folderName ? t('brief.sliceScopeFolder', { name: folderName }) : t('brief.sliceScopeRoot')
    return `${what} · ${where}`
  }

  const select = (next: BriefSelection) => {
    setSelection({ folderId: selectedFolderId, selection: next })
    // The slice is drawn from the documents themselves, which a partial brief does not hold.
    if (partial) onRequestDetails()
  }

  return {
    brief: brief ? (
      <FolderBrief
        brief={brief}
        folderName={folderName}
        shelfKind={shelf.source}
        onSelect={select}
        onOpenFolder={onOpenFolder}
        onReadAgain={mayReadAgain ? () => void readAgain() : undefined}
        readAgainProgress={bulk.progress}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        missing={missing}
        onLoadDetails={partial ? onRequestDetails : undefined}
        detailsLoading={detailsLoading}
      />
    ) : null,
    slice: active
      ? {
          files: brief && !partial ? selectInBrief(brief, active) : NO_FILES,
          loading: !brief || partial,
          label: sliceLabel(active),
          onClear: () => setSelection(null),
        }
      : undefined,
  }
}

/**
 * Who may write where on this shelf (ADR-0088), as the listing reported it.
 *
 * A project's folders carry an `access` per reader and the listing says what
 * the reader may do at the root; a level they may only read offers no upload,
 * no new folder and no write action on its documents. The Archiv has no
 * folder access lists (its folders are governed by `canManage`), so without
 * `shelf.folderAccess` every level is writable here and the shelf's own
 * `canManage` decides. The server decides every write again either way.
 */
function useFolderAccess(shelf: FileShelf, folders: readonly FolderItem[], treeRootAccess: FolderAccessLevel) {
  const { folderAccess } = shelf
  const rootAccess: FolderAccessLevel = folderAccess ? treeRootAccess : 'write'
  /** The folder whose access dialog is open. */
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)

  const accessAt = useCallback(
    (folderId: string | null): FolderAccessLevel => {
      if (!folderAccess) return 'write'
      if (folderId === null) return rootAccess
      return folders.find((folder) => folder.id === folderId)?.access === 'read' ? 'read' : 'write'
    },
    [folderAccess, folders, rootAccess]
  )
  const mayWriteAt = useCallback((folderId: string | null) => accessAt(folderId) === 'write', [accessAt])
  const documentActionsAt = useCallback(
    (folderId: string | null): readonly DocumentActionKind[] =>
      accessAt(folderId) === 'read' ? READ_ONLY_DOCUMENT_ACTIONS : DEFAULT_DOCUMENT_ACTIONS,
    [accessAt]
  )

  /** The folder navigation's access fields; empty on a shelf without folder access. */
  const folderNav = folderAccess
    ? {
        onEditFolderAccess: folderAccess.canManage ? setEditingFolderId : undefined,
        rootAccess,
      }
    : {}

  return { mayWriteAt, documentActionsAt, folderNav, editingFolderId, setEditingFolderId }
}

/**
 * The one moment that matters: a document finishes async ingestion and becomes
 * citable. Provenance-correct — the shelf's colour and icon, never colour alone.
 * A model earns different words: "citable" describes what happens to a PDF and
 * is the wrong promise for a building, whose point is that it can be COUNTED.
 */
function useCompletionToast(files: FileItem[], shelf: FileShelf): void {
  const t = useTranslations('files')
  const { source, messages } = shelf
  useIngestionCompleteToast(
    files,
    useCallback(
      (file: FileItem) => {
        const isModel =
          inferDocumentKind({ filename: file.filename, contentType: file.contentType, tags: file.tags }) ===
          'model'
        const Icon = isModel ? Boxes : source === 'office' ? Archive : FileText
        toast.success(
          isModel
            ? t('toast.modelReady', { name: documentDisplayName(file) })
            : messages.ingestionComplete(documentDisplayName(file)),
          { icon: <Icon className="size-4" style={{ color: sourceBase(source) }} aria-hidden /> }
        )
      },
      [t, source, messages]
    )
  )
}

/** Upload/validation/network errors the upload hook computes: a persistent inline Alert plus a transient toast. */
function useErrorToast(error: string | null): void {
  const lastToasted = useRef<string | null>(null)
  useEffect(() => {
    if (error && error !== lastToasted.current) {
      lastToasted.current = error
      toast.error(error)
    }
    if (!error) lastToasted.current = null
  }, [error])
}

/**
 * When a FILTER emptied the level rather than the folder being empty.
 *
 * The browser pane is handed already-filtered files and cannot tell the two
 * apart, so it drew "this folder is empty" over a folder full of documents the
 * moment a filter matched nothing. Authorship wins when several are on: it is
 * the narrower and the less obvious, so it is the one a reader needs explained.
 */
function useFilterEmptyNotice({
  filters,
  setFilters,
  canCollaborate,
  search,
  levelFiles,
  levelOccupied,
}: {
  filters: FileFilters
  setFilters: (next: FileFilters) => void
  canCollaborate: boolean
  search: ReturnType<typeof useFileSearch>
  levelFiles: readonly FileItem[]
  /**
   * Whether the level holds documents before the browser's filters: the
   * shelf summary's count on a paged level (ADR-0102), the drained rows else.
   */
  levelOccupied: boolean
}) {
  const t = useTranslations('files')
  const { query } = search
  const semanticActive = search.semantic.active
  return useMemo(() => {
    const clear = () => setFilters(NO_FILE_FILTERS)
    if (activeFilterCount(filters, canCollaborate) === 0) return null
    // The notice REPLACES the whole listing, so it may only exist when the
    // listing is actually empty; a query or semantic search owns its own states.
    if (query.trim() !== '' || semanticActive) return null
    if (levelFiles.length > 0) return null
    // An unfiltered-empty level is an empty folder, not a filter hiding anything.
    if (!levelOccupied) return null
    if (filters.agentAuthoredOnly) {
      return { title: t('authorship.emptyTitle'), description: t('authorship.emptyDescription'), onClear: clear }
    }
    if (canCollaborate && filters.assignment !== 'all') {
      const title = filters.assignment === 'mine' ? t('assignment.emptyMine') : t('assignment.emptyUnassigned')
      return { title, description: t('assignment.emptyDescription'), onClear: clear }
    }
    // Type, status and tag say what they mean on the chip; what the reader needs
    // is the fact that a filter, and not an empty folder, is why it is empty.
    return { title: t('filters.emptyTitle'), description: t('filters.emptyDescription'), onClear: clear }
  }, [filters, setFilters, canCollaborate, t, query, semanticActive, levelFiles, levelOccupied])
}

/** Inline pane-level load failure with a retry affordance. */
function PaneLoadError({
  message,
  onRetry,
  inline = false,
}: {
  message: string
  onRetry: () => void
  /** One-row banner variant, for a failure that degrades a pane without emptying it. */
  inline?: boolean
}) {
  const t = useTranslations('files')
  const retry = (
    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
      <RotateCcw className="size-3.5" aria-hidden />
      {t('workspace.tryAgain')}
    </Button>
  )
  if (!inline) return <EmptyState variant="bare" icon={AlertCircle} title={message} action={retry} />
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      <AlertCircle className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {retry}
    </div>
  )
}
