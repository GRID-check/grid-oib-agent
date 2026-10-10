'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import { AlertCircle, Archive, Boxes, FileText, LayoutGrid, List, RotateCcw, Trash2, X } from 'lucide-react'
import Link from 'next/link'
import { sourceBase } from '@/lib/ui/source-tint'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLocale, useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import { inferDocumentKind } from '../document-kind'
import type { FileItem, FolderItem } from '../file-types'
import { useDocParamSync, usePreviewChannel, type PreviewHandlers } from '../hooks/use-preview-channel'
import { useDocumentMoves } from '../hooks/use-document-moves'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { useFileListing } from '../hooks/use-file-listing'
import { useFileSearch } from '../hooks/use-file-search'
import { useFolderParam } from '../hooks/use-folder-param'
import { useFolderTree } from '../hooks/use-folder-tree'
import { useIngestionCompleteToast } from '../hooks/use-ingestion-complete-toast'
import { useModelStage } from '../hooks/use-model-stage'
import { useSettleTrackedUploads } from '../hooks/use-settle-tracked-uploads'
import { useShelfUpload } from '../hooks/use-shelf-upload'
import { useViewPreference } from '../hooks/use-view-preference'
import type { DocumentWireRow } from '../lib/file-item'
import {
  NO_FILE_FILTERS,
  activeFilterCount,
  applyFileFilters,
  tagOptions as tagOptionsOf,
  type FileFilters,
} from '../lib/file-filters'
import type { FileShelf, FolderAccessLevel } from '../lib/file-shelf'
import { DEFAULT_FILE_SORT, type FileSort } from '../lib/file-sort'
import { DocumentActionsTrigger, DocumentObjectMenu } from './document-actions'
import {
  DEFAULT_DOCUMENT_ACTIONS,
  READ_ONLY_DOCUMENT_ACTIONS,
  type DocumentActionKind,
} from './document-actions/action-entries'
import { roleNamesFor, useOrganizationRoles } from '@/features/organization/hooks/use-organization-roles'
import { FileBrowserPane } from './file-browser-pane'
import { FileDropOverlay, useWindowDragGuard } from './file-drop-overlay'
import { FileFilterMenu } from './file-filter-menu'
import { FilePreviewDialog } from './file-preview-dialog'
import { FileSearchField } from './file-search-bar'
import { FolderAccessDialog } from './folder-access-dialog'
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
   * `count` is null until the listing is in.
   */
  renderHeader: (controls: ReactNode, state: { count: number | null }) => ReactNode
  /**
   * The folder tree and the corpus as the SERVER already read them, for the
   * first paint. They seed state; everything after the first frame goes through
   * the same loaders it always did. `initialFilesComplete` false means the seed
   * is only the first page and the rest is read quietly right after.
   */
  initialFolders?: readonly FolderItem[]
  initialFiles?: readonly DocumentWireRow[]
  initialFilesComplete?: boolean
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
  initialFolders,
  initialFiles,
  initialFilesComplete = true,
}: FileWorkspaceProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const { canManage, canCollaborate } = shelf

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

  // „Von Piloti" and „auch archivierte" are asked of the SERVER (a partial
  // index, and a default listing that does not contain them at all): the
  // listing refetches on them instead of filtering what it has.
  const listing = useFileListing({
    endpoints: shelf.endpoints,
    agentAuthoredOnly: filters.agentAuthoredOnly,
    includeArchived: filters.includeArchived,
    initialFiles,
    initialFilesComplete,
  })
  const { files, setFiles } = listing
  const collectionName = shelf.collectionName ?? listing.collectionName

  const upload = shelf.useUpload({
    collectionName,
    folderId: selectedFolderId ?? undefined,
    onComplete: listing.reloadQuietly,
  })
  const { isUploading, error } = upload

  const tree = useFolderTree({
    foldersUrl: shelf.endpoints.folders,
    initialFolders,
    initialRootAccess: shelf.folderAccess?.initialRootAccess,
    files,
    selectedFolderId,
    onSelectFolder: selectFolder,
    reloadFiles: listing.load,
    binHref: shelf.bin?.href,
  })
  const { folders } = tree
  const moves = useDocumentMoves(files, setFiles, folders)
  const shelfUpload = useShelfUpload({
    shelf,
    upload,
    folders,
    foldersReady: !tree.isLoading && !tree.error,
    selectedFolderId,
    loadFolders: tree.load,
    loadFiles: listing.load,
  })
  const { handleUpload } = shelfUpload
  const access = useFolderAccess(shelf, folders, tree.rootAccess)
  const writableHere = access.mayWriteAt(selectedFolderId)

  const patchFile = useCallback(
    (fileId: string, patch: Partial<FileItem>) =>
      setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, ...patch } : f))),
    [setFiles]
  )

  /*
   * Patched, not refetched: each of these is durable the moment its request
   * returns, and the card, the list row and the preview header all read the
   * same `files` — they carry the change in the same frame the dialog closes.
   */
  const handlers = useMemo<PreviewHandlers>(
    () => ({
      // After a successful re-ingestion the document is back to 'pending'; the
      // dead-end failure UI clears and the badge flips to "Processing".
      onReingested: (id, status) => patchFile(id, { status, errorMessage: null }),
      // The pane is reused across files and re-seeds from the tags on switch.
      onTagsUpdated: (id, tags) => patchFile(id, { tags }),
      // A Freigabe decision moved the document's state; the panel has just
      // re-read the version list, so both numbers are the server's own.
      onLifecycleChanged: (id, summary: { versionState: DocumentVersionState; versionCount: number }) =>
        patchFile(id, summary),
      onDeleted: (id) => setFiles((prev) => prev.filter((f) => f.id !== id)),
      onRenamed: (id, displayName) => patchFile(id, { displayName }),
    }),
    [patchFile, setFiles]
  )

  const channel = usePreviewChannel(shelf, files, handlers)
  const stage = useModelStage(shelf.showModels, files)

  /**
   * Open a file's preview. It does NOT touch the URL: `?doc=` has one writer,
   * the reconciler below, because the preview can also be opened from a link and
   * shut by three controls this function never hears about.
   *
   * An `.ifc` opens the way every other file opens — unless the flag says to go
   * straight to the stage. Both shelves read the same flag, so they cannot
   * answer this differently.
   */
  const handleSelectFile = useCallback(
    (id: string | null) => {
      if (id === null) return channel.close()
      const file = files.find((candidate) => candidate.id === id)
      if (!file) return
      const goesToStage =
        !shelf.previewFirst &&
        shelf.showModels &&
        inferDocumentKind({ filename: file.filename, contentType: file.contentType, tags: file.tags }) ===
          'model'
      if (goesToStage) return stage.openModel(file.filename)
      channel.open(file)
    },
    [files, shelf.previewFirst, shelf.showModels, stage, channel]
  )
  useDocParamSync({
    openId: channel.openId,
    files,
    onUrlOpen: handleSelectFile,
    onUrlClose: channel.close,
  })

  useCompletionToast(files, shelf)
  useErrorToast(error)

  // Refetch the corpus when an upload batch settles (covers non-orchestrated paths).
  const wasUploading = useRef(false)
  useEffect(() => {
    if (wasUploading.current && !isUploading) void listing.load()
    wasUploading.current = isUploading
  }, [isUploading, listing])

  // This session's own uploads for this shelf's corpus, in every phase, so the
  // tray carries a batch from queued to its summary. `file` being present marks
  // a row as ours: server-loaded documents belong in the browser, never the tray.
  const activeUploads = useMemo(
    () => upload.trackedFiles.filter((f) => f.collectionName === collectionName && f.file != null),
    [upload.trackedFiles, collectionName]
  )
  // Settles the tray rows no ingest job will — a detached extraction (`.ifc`, an
  // office file read from its PDF rendition).
  useSettleTrackedUploads(files, activeUploads)

  // A level the reader may only read (ADR-0088) takes no dropped files. The
  // server refuses either way; this keeps the surface from offering it.
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: handleUpload,
    disabled: isUploading || !canManage || !writableHere,
    acceptZip: true,
  })
  useWindowDragGuard()

  const filteredFiles = useMemo(
    () => applyFileFilters(files, filters, { canCollaborate, currentUserId: shelf.currentUserId }),
    [files, filters, canCollaborate, shelf.currentUserId]
  )
  // A search escapes the folder, so it runs over the corpus.
  const levelFiles = useMemo(
    () =>
      tree.error
        ? filteredFiles
        : filteredFiles.filter((file) => (file.folderId ?? null) === selectedFolderId),
    [filteredFiles, selectedFolderId, tree.error]
  )
  const tagOptions = useMemo(() => tagOptionsOf(files, locale), [files, locale])
  const filterEmptyNotice = useFilterEmptyNotice({
    filters,
    setFilters,
    canCollaborate,
    search,
    levelFiles,
    files,
    selectedFolderId,
    foldersFailed: tree.error,
  })

  const pickFilesRef = useRef<(() => void) | null>(null)
  const pickFolderRef = useRef<(() => void) | null>(null)
  // No upload into a level the reader may only read (ADR-0088).
  const uploader = (props: Partial<Parameters<typeof ProjectUppyUpload>[0]>) =>
    canManage && writableHere ? (
      <ProjectUppyUpload
        folderId={selectedFolderId}
        onUpload={handleUpload}
        isUploading={isUploading}
        {...props}
      />
    ) : undefined

  const controls = (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
      <ToggleGroup
        type="single"
        value={view}
        onValueChange={(value) => {
          if (value === 'cards' || value === 'list') selectView(value)
        }}
        segmented
        size="icon-sm"
        aria-label={t('workspace.view.label')}
      >
        <ToggleGroupItem value="cards" aria-label={t('workspace.view.cards')} title={t('workspace.view.cards')}>
          <LayoutGrid />
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label={t('workspace.view.list')} title={t('workspace.view.list')}>
          <List />
        </ToggleGroupItem>
      </ToggleGroup>
      {/* The Papierkorb: deleted folders, restorable until their purge (ADR-0088). */}
      {shelf.bin && (
        <Button asChild variant="ghost" size="icon" aria-label={t('workspace.openBin')} title={t('workspace.openBin')}>
          <Link href={shelf.bin.href} data-testid="files-open-bin">
            <Trash2 />
          </Link>
        </Button>
      )}
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
      />
      {/* The corpus search, in the header with the other controls that act on
          the listing. No run button: the field reads as the plain filter it
          mostly is, and Enter commits the query to the semantic search. */}
      <FileSearchField
        className="w-full sm:w-64 lg:w-72"
        value={search.query}
        onChange={search.setQuery}
        onSubmit={search.run}
        onClear={search.clear}
        placeholder={t('browser.searchPlaceholder')}
        searchLabel={t('browser.searchLabel')}
        resetLabel={t('browser.resetSearch')}
      />
      {/* The durable corpus is where a büro brings a whole tree in. */}
      {uploader({ allowFolders: true, pickFilesRef, pickFolderRef })}
    </div>
  )

  const objectMenu = (file: FileItem, node: ReactNode, asChild = false) => (
    <DocumentObjectMenu
      asChild={asChild}
      document={file}
      scope={shelf.documentScope}
      canManage={canManage}
      actions={access.documentActionsAt(file.folderId)}
      folders={folders}
      onOpen={() => handleSelectFile(file.id)}
      onAsk={shelf.askAbout ? () => shelf.askAbout?.(file) : undefined}
      onRenamed={handlers.onRenamed}
      onDeleted={handlers.onDeleted}
      onMoved={moves.moved}
      onReingested={handlers.onReingested}
    >
      {node}
    </DocumentObjectMenu>
  )

  return (
    <div className="relative flex h-full flex-col" {...(canManage ? dragHandlers : {})} data-testid="workspace-dropzone">
      {canManage && isDragging && (
        <FileDropOverlay
          isUnsupported={isUnsupportedDrag}
          uploadLabel={shelf.messages.dropToUpload}
          unsupportedLabel={t('workspace.dropUnsupported')}
          testId="workspace-drop-overlay"
        />
      )}

      {renderHeader(controls, { count: listing.isLoading || listing.error ? null : files.length })}

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
        {listing.truncated && (
          <div className="border-b px-4 py-2">
            <Alert>
              <AlertCircle className="size-4" />
              <AlertDescription>{t('workspace.listTruncated', { count: files.length })}</AlertDescription>
            </Alert>
          </div>
        )}

        <div className="scroll-fade-bottom min-h-0 min-w-0 flex-1 overflow-y-auto">
          {listing.error ? (
            <PaneLoadError message={t('workspace.documentsLoadError')} onRetry={() => void listing.load()} />
          ) : (
            <FileBrowserPane
              files={levelFiles}
              searchFiles={filteredFiles}
              selectedFileId={channel.openId}
              onSelectFile={handleSelectFile}
              isLoading={listing.isLoading || tree.isLoading}
              search={search}
              view={view}
              onViewChange={selectView}
              sort={sort}
              onSortChange={setSort}
              showAssignment={canCollaborate}
              filterEmptyNotice={filterEmptyNotice}
              onDropDocumentInFolder={canManage ? moves.dropInFolder : undefined}
              onDropFolderInFolder={canManage ? tree.move : undefined}
              onPickFiles={canManage ? () => pickFilesRef.current?.() : undefined}
              onPickFolder={canManage ? () => pickFolderRef.current?.() : undefined}
              cardExtras={shelf.cardExtras}
              wrapFile={(file, card) => objectMenu(file, card)}
              wrapFileRow={(file, row) => objectMenu(file, row, true)}
              renderActions={() => <DocumentActionsTrigger />}
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
                      ...access.folderNav,
                    },
                  })}
              uploadControl={uploader({
                variant: 'default',
                size: 'default',
                label: t('workspace.uploadDocuments'),
              })}
              uploadCard={uploader({ variant: 'dropcard' })}
            />
          )}
        </div>
      </div>

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
      />

      {/* Who may read and write a folder (ADR-0088), a project's only. Saving
          moves and re-reads the folder's documents, so both listings are read
          again. */}
      {shelf.folderAccess && (
        <FolderAccessDialog
          open={access.editingFolderId !== null}
          onOpenChange={(next) => !next && access.setEditingFolderId(null)}
          projectId={shelf.folderAccess.projectId}
          folder={folders.find((folder) => folder.id === access.editingFolderId) ?? null}
          roles={access.roles.data}
          rolesFailed={access.roles.failed}
          onRetryRoles={() => void access.roles.reload()}
          onSaved={() => {
            void tree.load()
            void listing.load(true)
          }}
        />
      )}

      {shelf.preview.kind === 'dialog' && (
        <FilePreviewDialog
          file={channel.dialogFile}
          canManage={canManage}
          scope={shelf.documentScope}
          onClose={channel.close}
          showMetadataPanel={shelf.showMetadataPanel}
          showModels={shelf.showModels}
          onReingested={handlers.onReingested}
          onTagsUpdated={handlers.onTagsUpdated}
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
    </div>
  )
}

/**
 * Who may write where on this shelf (ADR-0088), as the listing reported it.
 *
 * A project's folders carry an `access` per reader and the listing says what
 * the reader may do at the root; a level they may only read offers no upload,
 * no new folder and no write action on its documents. The Archiv has no
 * per-role folder access (its folders are governed by `canManage`), so without
 * `shelf.folderAccess` every level is writable here and the shelf's own
 * `canManage` decides. The server decides every write again either way.
 */
function useFolderAccess(shelf: FileShelf, folders: readonly FolderItem[], treeRootAccess: FolderAccessLevel) {
  const { folderAccess } = shelf
  const rootAccess: FolderAccessLevel = folderAccess ? treeRootAccess : 'write'
  /** The folder whose access dialog is open. */
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  // Role names are read only when something needs them: a lock to label, or
  // the access dialog to fill.
  const anyRestricted = folders.some((folder) => (folder.grants?.length ?? 0) > 0)
  const roles = useOrganizationRoles(Boolean(folderAccess) && (anyRestricted || editingFolderId !== null))
  const roleNames = useCallback(
    (slugs: readonly string[]) => roleNamesFor(slugs, roles.data),
    [roles.data]
  )

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
        roleNames,
        rootAccess,
      }
    : {}

  return { mayWriteAt, documentActionsAt, folderNav, editingFolderId, setEditingFolderId, roles }
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
  files,
  selectedFolderId,
  foldersFailed,
}: {
  filters: FileFilters
  setFilters: (next: FileFilters) => void
  canCollaborate: boolean
  search: ReturnType<typeof useFileSearch>
  levelFiles: readonly FileItem[]
  files: readonly FileItem[]
  selectedFolderId: string | null
  foldersFailed: boolean
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
    const levelOccupied = foldersFailed
      ? files.length > 0
      : files.some((file) => (file.folderId ?? null) === selectedFolderId)
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
  }, [filters, setFilters, canCollaborate, t, query, semanticActive, levelFiles, files, selectedFolderId, foldersFailed])
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
