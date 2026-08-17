'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { AlertCircle, Boxes, FileText, LayoutGrid, List, ListTree, RotateCcw, X } from 'lucide-react'
import { sourceBase } from '@/lib/ui/source-tint'
import { useProjectDocuments } from '../hooks/use-project-documents'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { useIngestionCompleteToast } from '../hooks/use-ingestion-complete-toast'
import { useSettlingRefresh } from '../hooks/use-settling-refresh'
import { inferDocumentKind } from '../document-kind'
import { FolderTreePane } from './folder-tree-pane'
import { FileBrowserPane } from './file-browser-pane'
import { DocumentActionsMenu } from './document-actions'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { FileDropOverlay, useWindowDragGuard } from './file-drop-overlay'
import { ProjectUppyUpload } from './project-uppy-upload'
import { UploadTray } from './upload-tray'
import { ProjectSectionActions } from '@/components/shell'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { documentDisplayName } from '@/lib/documents/display-name'

interface ProjectFileWorkspaceProps {
  projectId: string
  projectName: string
  collectionName: string
  /**
   * Whether the file preview's ingestion-metadata block renders (WorkOS
   * `files-metadata-panel` flag, FB-8). Threaded to FilePreviewPane. Defaults
   * to true so the feature stays visible with flag enforcement off (fail-open).
   */
  showMetadataPanel?: boolean
  /**
   * Whether an `.ifc` opens as a building (WorkOS `ifc-models`, ADR-0046).
   *
   * The model viewer used to be a page of its own behind this flag. It is a
   * file preview now — there is no route left to hide — so the flag decides
   * what a click on a model card DOES: open the viewer, or fall through to the
   * ordinary file preview. Off by default here, because a viewer whose
   * endpoints answer 403 is worse than no viewer.
   */
  showModels?: boolean
  /** Faces, Unvergeben, Zuweisen — behind the collaboration flag. */
  canCollaborate?: boolean
  currentUserId?: string
}

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

export interface FolderItem {
  id: string
  parentId: string | null
  name: string
  path: string
}

export interface FileItem {
  id: string
  /**
   * The file's own name — its identity, and what its format is read from.
   * What to SHOW is `documentDisplayName(file)`, never this directly.
   */
  filename: string
  /** The rename, when somebody has given the document one; else null. */
  displayName: string | null
  fileSize: number | null
  contentType: string | null
  status: string | null
  folderId: string | null
  createdAt: string
  /** Server-persisted reason a document is in `failed` status, if any. */
  errorMessage: string | null
  /** One-sentence summary of the document content, if the backend generated one. */
  summary: string | null
  /** Number of pages the backend indexed for this document. */
  pageCount: number | null
  /** Number of retrieval chunks the backend produced for this document. */
  chunkCount: number | null
  /** Content categories present in the document (e.g. text, table, chart, image). */
  contentTypes: string[] | null
  /** Controlled ingestion-generated tags (document type + OIB discipline). */
  tags: string[] | null
  /** Who is on the hook. Empty = Unvergeben. Absent when collaboration is off. */
  assignees?: readonly FileAssignee[]
}

export interface FileAssignee {
  userId: string
  name: string | null
  email: string | null
  profilePictureUrl: string | null
}

/**
 * A `/api/documents` row as it arrives over the wire — the JSON projection of
 * `listDocuments`. Everything ingestion derives (summary, page/chunk counts,
 * content types, tags) is absent until the backend has produced it, which is
 * why each is normalized to `null` when the response is mapped to `FileItem`.
 */
type DocumentWireRow = Omit<FileItem, OptionalWireField> & Partial<Pick<FileItem, OptionalWireField>>

type OptionalWireField =
  | 'displayName'
  | 'folderId'
  | 'errorMessage'
  | 'summary'
  | 'pageCount'
  | 'chunkCount'
  | 'contentTypes'
  | 'tags'
  | 'assignees'

/**
 * Presentation of the file browser.
 *
 * `cards` browses, `list` is the explorer detail view for a corpus too large to
 * skim as tiles, `tree` puts the folder hierarchy alongside the cards. All
 * three read the same documents through the same search and folder filter.
 */
type FileView = 'cards' | 'list' | 'tree'

const VIEW_STORAGE_KEY = 'grid.files.view'

export function ProjectFileWorkspace({ projectId, projectName, collectionName, showMetadataPanel = true, showModels = false, canCollaborate = false, currentUserId }: ProjectFileWorkspaceProps) {
  const t = useTranslations('files')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  /**
   * `?model=` is what turns this page into the viewer.
   *
   * In the URL rather than in state, and that is the whole integration: the
   * stage is a view of this page, so it is linkable, the back button closes
   * it, and every `/model?…` link ever written into a chat answer redirects
   * here and opens the same thing. Dateien itself learns exactly one fact —
   * whether that parameter is present.
   */
  const stageModel = showModels ? (searchParams?.get('model')?.trim() ?? null) : null

  const openModel = useCallback(
    (filename: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('model', filename)
      // `push`, not `replace`. The comment above says the back button closes
      // the stage; with `replace` it pushed no history entry, so back left the
      // Files page entirely and discarded the camera, the cut, the selection,
      // the hidden set and every measurement. On a phone, back is the primary
      // way anyone dismisses a full-screen overlay.
      //
      // Closing still REPLACES, so shutting the stage does not leave an entry
      // that back would re-open.
      router.push(`${pathname ?? ''}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  /**
   * Close the viewer, and take its whole view with it.
   *
   * Dropping only `model` would leave `element`, `hl`, `storey` and the camera
   * behind as dead parameters on the file browser — and re-opening any model
   * afterwards would inherit a selection from a different building.
   */
  const closeModel = useCallback(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    for (const key of ['model', 'element', 'storey', 'xray', 'tab', 'view', 'cut', 'cutup', 'proj']) {
      params.delete(key)
    }
    params.delete('hl')
    const query = params.toString()
    const path = pathname ?? ''
    router.replace(query ? `${path}?${query}` : path, { scroll: false })
  }, [pathname, router, searchParams])
  // Default to the card grid (the click-dummy). The folder-tree workspace stays
  // one click away and the choice persists per browser (sidebar-collapse pattern).
  const [view, setView] = useState<FileView>('cards')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY)
    if (stored === 'cards' || stored === 'list' || stored === 'tree') setView(stored)
  }, [])
  const selectView = useCallback((next: FileView) => {
    setView(next)
    if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_STORAGE_KEY, next)
  }, [])
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [files, setFiles] = useState<FileItem[]>([])
  const [isLoadingFolders, setIsLoadingFolders] = useState(true)
  const [isLoadingFiles, setIsLoadingFiles] = useState(true)
  const [foldersError, setFoldersError] = useState(false)
  const [filesError, setFilesError] = useState(false)

  /**
   * Only the LATEST request may commit its answer.
   *
   * `useSettlingRefresh` serialises its OWN polls, but nothing coordinated a
   * poll already in flight with a FOREGROUND load (mount, upload settled,
   * `onComplete`, retry). A slow poll response carrying `processing` could
   * therefore land after a newer foreground response carrying `ready` and
   * overwrite it — regressing the badge the user was just told had flipped,
   * and, because the row went back to unsettled, restarting the poll. A
   * monotonic generation stamped when the request goes out and re-checked
   * before every state write makes the newest request the only one that can
   * win, whatever order the responses come back in. The Archiv workspace
   * carries the same guard over its own loader.
   */
  const loadGeneration = useRef(0)

  /**
   * @param quiet Refresh without the skeleton — used by the settling poll
   *   below, which would otherwise flash the whole grid every few seconds.
   */
  const loadFiles = useCallback((quiet = false) => {
    const generation = ++loadGeneration.current
    const isStale = () => generation !== loadGeneration.current
    if (!quiet) setIsLoadingFiles(true)
    setFilesError(false)
    const params = new URLSearchParams({ projectId })
    return fetch(`/api/documents?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load documents (${r.status})`)
        return r.json() as Promise<{ documents?: DocumentWireRow[] }>
      })
      .then((data) => {
        if (isStale()) return
        const docs: FileItem[] = (data.documents ?? []).map((d) => ({
          id: d.id,
          filename: d.filename,
          displayName: d.displayName ?? null,
          fileSize: d.fileSize,
          contentType: d.contentType,
          status: d.status,
          folderId: d.folderId ?? null,
          createdAt: d.createdAt,
          errorMessage: d.errorMessage ?? null,
          summary: d.summary ?? null,
          pageCount: d.pageCount ?? null,
          chunkCount: d.chunkCount ?? null,
          contentTypes: d.contentTypes ?? null,
          tags: d.tags ?? null,
          assignees: d.assignees ?? [],
        }))
        setFiles(docs)
      })
      .catch(() => {
        // A failed POLL must not empty a list the user is looking at; only a
        // foreground load owns the error state — and only while it is still the
        // latest one, so a late failure cannot blank a newer successful list.
        if (quiet || isStale()) return
        setFiles([])
        setFilesError(true)
      })
      .finally(() => {
        // Deliberately NOT generation-guarded: the spinner belongs to the
        // foreground loads alone, and a quiet poll starting mid-load would
        // otherwise leave it spinning forever with nobody left to clear it.
        if (!quiet) setIsLoadingFiles(false)
      })
  }, [projectId])

  const { uploadFiles, isUploading, trackedFiles, error, clearError, retryFile, cancelFile, cancelUpload, dismissFiles } =
    useProjectDocuments({
      projectId,
      folderId: selectedFolderId ?? undefined,
      // Refresh the durable file list once ingestion of an upload completes so
      // new documents appear without a manual reload. Wrapped rather than passed
      // directly: `loadFiles` now takes a `quiet` flag, and whatever the
      // orchestrator hands its callback must not decide how this renders.
      onComplete: () => void loadFiles(),
    })

  // Fetch folders
  const loadFolders = useCallback(() => {
    setIsLoadingFolders(true)
    setFoldersError(false)
    return fetch(`/api/projects/${projectId}/folders`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load folders (${r.status})`)
        return r.json()
      })
      .then((data) => setFolders(data.folders ?? []))
      .catch(() => {
        setFolders([])
        setFoldersError(true)
      })
      .finally(() => setIsLoadingFolders(false))
  }, [projectId])

  useEffect(() => {
    void loadFolders()
  }, [loadFolders])

  // Fetch files
  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  // Surface upload/validation/network errors that the hook computes: a persistent
  // inline Alert plus a transient toast. Previously these were never rendered.
  const lastToastedError = useRef<string | null>(null)
  useEffect(() => {
    if (error && error !== lastToastedError.current) {
      lastToastedError.current = error
      toast.error(error)
    }
    if (!error) {
      lastToastedError.current = null
    }
  }, [error])

  // Confirm the one moment that matters: the instant a document finishes async
  // ingestion and becomes citable. Provenance-correct — project green + doc icon
  // (spec §4, color never travels alone). Fires once per newly-completed file.
  useIngestionCompleteToast(
    files,
    useCallback(
      (file: FileItem) => {
        // A model earns different words. "Citable" describes what happens to a
        // PDF — its text can be quoted back — and it is the wrong promise for a
        // building, whose whole point is that it can be COUNTED. The user has
        // just waited tens of seconds for an extraction with no visible end;
        // this is where that ends, so it says what is now possible.
        const isModel =
          inferDocumentKind({
            filename: file.filename,
            contentType: file.contentType,
            tags: file.tags,
          }) === 'model'
        toast.success(
          t(isModel ? 'toast.modelReady' : 'toast.ingestionComplete', { name: documentDisplayName(file) }),
          {
            icon: isModel ? (
              <Boxes className="size-4" style={{ color: sourceBase('project') }} aria-hidden />
            ) : (
              <FileText className="size-4" style={{ color: sourceBase('project') }} aria-hidden />
            ),
          }
        )
      },
      [t]
    )
  )

  // Re-ask while anything is still being read, and stop the moment everything
  // is terminal. The Archiv workspace runs the same poll over its own loader —
  // see `useSettlingRefresh` for why a detached `.ifc` extraction needs it.
  useSettlingRefresh(files, loadFiles)

  // Refetch the corpus when an upload batch settles (covers non-orchestrated paths).
  const wasUploading = useRef(false)
  useEffect(() => {
    if (wasUploading.current && !isUploading) {
      void loadFiles()
    }
    wasUploading.current = isUploading
  }, [isUploading, loadFiles])

  const [assignmentFilter, setAssignmentFilter] = useState<'all' | 'mine' | 'unassigned'>('all')

  const docParam = searchParams?.get('doc')
  const filteredFiles = useMemo(() => {
    const inFolder = selectedFolderId ? files.filter((f) => f.folderId === selectedFolderId) : files
    if (!canCollaborate || assignmentFilter === 'all') return inFolder
    if (assignmentFilter === 'unassigned') {
      return inFolder.filter((file) => !file.assignees || file.assignees.length === 0)
    }
    return inFolder.filter((file) => file.assignees?.some((person) => person.userId === currentUserId))
  }, [files, selectedFolderId, canCollaborate, assignmentFilter, currentUserId])

  // After a successful re-ingestion the document is back to 'pending'; reflect
  // that locally so the badge flips to "Processing" and the dead-end failure UI
  // clears. Server-side reconciliation resolves the final status on the next read.
  const handleReingested = useCallback((fileId: string, status: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status, errorMessage: null } : f))
    )
  }, [])

  // After the preview pane successfully saves tags, mirror them into the local
  // files state so the pane's `initialTags` is fresh if the file is reselected
  // (the pane is reused across files and re-seeds from initialTags on switch).
  const handleTagsUpdated = useCallback((fileId: string, tags: string[]) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, tags } : f)))
  }, [])

  // After a document is deleted, drop it from the local corpus and close the
  // preview overlay if it was the selected file.
  const handleDeleted = useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
    setSelectedFileId((current) => (current === fileId ? null : current))
  }, [])

  // A rename is durable the moment the PATCH returns, so the corpus is updated
  // from the response rather than refetched: the card, the list row and the
  // preview header all read the same `files` state, and they should carry the
  // new name in the same frame the dialog closes.
  const handleRenamed = useCallback((fileId: string, displayName: string | null) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, displayName } : f)))
  }, [])

  const handleSelectFile = useCallback(
    (id: string | null) => {
      if (id === null) {
        setSelectedFileId(null)
        useFilePreviewStore.getState().close()
        return
      }
      const file = files.find((candidate) => candidate.id === id)
      if (!file) return
      const isModel =
        inferDocumentKind({
          filename: file.filename,
          contentType: file.contentType,
          tags: file.tags,
        }) === 'model'
      if (showModels && isModel) {
        openModel(file.filename)
        return
      }
      setSelectedFileId(id)
      useFilePreviewStore.getState().open(file, 'modal', {
        projectId,
        projectName,
        scope: 'files',
        canCollaborate,
        showMetadataPanel,
        onRenamed: handleRenamed,
        onDeleted: handleDeleted,
        onReingested: handleReingested,
        onTagsUpdated: handleTagsUpdated,
      })
    },
    [
      files,
      showModels,
      openModel,
      projectId,
      projectName,
      canCollaborate,
      showMetadataPanel,
      handleRenamed,
      handleDeleted,
      handleReingested,
      handleTagsUpdated,
    ],
  )

  useEffect(() => {
    if (!docParam || files.length === 0) return
    if (useFilePreviewStore.getState().file?.id === docParam) return
    if (files.some((file) => file.id === docParam)) {
      handleSelectFile(docParam)
    }
  }, [docParam, files, handleSelectFile])

  // This session's own uploads for this project's corpus — every phase, so the
  // tray can carry a batch all the way from queued to its "added" summary
  // instead of dropping rows out from under the user as they settle. `file`
  // being present is what marks a row as ours: server-loaded documents belong
  // in the browser below, never in the upload tray.
  const activeUploads = useMemo(
    () => trackedFiles.filter((f) => f.collectionName === collectionName && f.file != null),
    [trackedFiles, collectionName]
  )

  // Drag-and-drop onto the workspace routes dropped files into the SAME upload
  // path the button uses (uploadFiles), which already targets the selected folder
  // via the hook's folderId. Validation/limits stay in uploadFiles; the drag hook
  // only surfaces a supported/unsupported affordance using the shared AppConfig.
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: uploadFiles,
    disabled: isUploading,
  })

  // Guard against the browser navigating away when a file is dropped outside the
  // drop zone (e.g. onto a gap in the layout). Prevent the default open-file
  // behaviour at the window level while this workspace is mounted.
  useWindowDragGuard()

  const handleCreateFolder = useCallback(
    async (name: string, parentId?: string) => {
      const res = await fetch(`/api/projects/${projectId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      })
      if (res.ok) {
        const data = await res.json()
        setFolders((prev) => [...prev, data.folder])
      } else {
        toast.error(t('workspace.createFolderError'))
      }
      return res.ok
    },
    [projectId, t]
  )

  return (
    <div className="relative flex h-full flex-col" {...dragHandlers} data-testid="workspace-dropzone">
      {/* Drag-and-drop overlay — mirrors the chat FileUploadZone affordance. */}
      {isDragging && (
        <FileDropOverlay
          isUnsupported={isUnsupportedDrag}
          uploadLabel={t('workspace.dropToUpload')}
          unsupportedLabel={t('workspace.dropUnsupported')}
          testId="workspace-drop-overlay"
        />
      )}

      <ProjectSectionActions>
        <div className="flex shrink-0 items-center gap-2">
          <div
            role="group"
            aria-label={t('workspace.view.label')}
            className="flex items-center rounded-lg border bg-card p-0.5 shadow-2xs"
          >
            <ViewToggleButton
              active={view === 'cards'}
              onClick={() => selectView('cards')}
              label={t('workspace.view.cards')}
              icon={LayoutGrid}
            />
            <ViewToggleButton
              active={view === 'list'}
              onClick={() => selectView('list')}
              label={t('workspace.view.list')}
              icon={List}
            />
            <ViewToggleButton
              active={view === 'tree'}
              onClick={() => selectView('tree')}
              label={t('workspace.view.tree')}
              icon={ListTree}
            />
          </div>
          {canCollaborate && (
            <div role="group" aria-label={t('assignment.responsible')} className="flex items-center gap-1">
              {(['all', 'mine', 'unassigned'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAssignmentFilter(key)}
                  className={cn(
                    'rounded-md px-2 py-1 text-[11px] font-medium',
                    assignmentFilter === key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(
                    key === 'all'
                      ? 'assignment.filterAll'
                      : key === 'mine'
                        ? 'assignment.filterMine'
                        : 'assignment.filterUnassigned',
                  )}
                </button>
              ))}
            </div>
          )}
          <ProjectUppyUpload
            projectId={projectId}
            folderId={selectedFolderId}
            onUpload={(files) => uploadFiles(files)}
            isUploading={isUploading}
          />
        </div>
      </ProjectSectionActions>

      {/* Error banner */}
      {error && (
        <div className="border-b px-4 py-3">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>{t('workspace.uploadProblem')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 size-6"
              onClick={clearError}
              aria-label={t('workspace.dismissError')}
            >
              <X className="size-4" />
            </Button>
          </Alert>
        </div>
      )}

      {/* Live upload progress */}
      <UploadTray
        files={activeUploads}
        onRetry={retryFile}
        onCancel={cancelFile}
        onCancelAll={cancelUpload}
        onDismiss={dismissFiles}
      />

      {/* Three-pane layout — stacks on mobile: folders on top, files below,
          preview as a full-screen overlay. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* Folder tree — only in the tree view; the card view navigates folders
            through the chip row instead. All tree functionality (expand/collapse,
            selection, drill-in, create) is preserved. */}
        {view === 'tree' && (
          <div className="max-h-72 w-full shrink-0 overflow-y-auto border-b md:max-h-none md:w-60 md:border-b-0 md:border-r">
            {foldersError ? (
              <PaneLoadError message={t('workspace.foldersLoadError')} onRetry={loadFolders} />
            ) : (
              <FolderTreePane
                folders={folders}
                selectedFolderId={selectedFolderId}
                onSelectFolder={setSelectedFolderId}
                onCreateFolder={handleCreateFolder}
                isLoading={isLoadingFolders}
              />
            )}
          </div>
        )}

        {/* File browser */}
        <div className="flex-1 overflow-y-auto">
          {filesError ? (
            <PaneLoadError message={t('workspace.documentsLoadError')} onRetry={loadFiles} />
          ) : (
            <FileBrowserPane
              files={filteredFiles}
              selectedFileId={selectedFileId}
              onSelectFile={handleSelectFile}
              isLoading={isLoadingFiles}
              hasFolderSelected={selectedFolderId !== null}
              projectId={projectId}
              view={view === 'list' ? 'list' : 'cards'}
              showAssignment={canCollaborate}
              renderActions={(file) => (
                <DocumentActionsMenu
                  document={file}
                  scope="files"
                  onRenamed={handleRenamed}
                  onDeleted={handleDeleted}
                />
              )}
              {...(view !== 'tree'
                ? {
                    folders,
                    selectedFolderId,
                    onSelectFolder: setSelectedFolderId,
                  }
                : {})}
              uploadControl={
                <ProjectUppyUpload
                  projectId={projectId}
                  folderId={selectedFolderId}
                  onUpload={(files) => uploadFiles(files)}
                  isUploading={isUploading}
                  variant="default"
                  size="default"
                  label={t('workspace.uploadDocuments')}
                />
              }
              uploadCard={
                <ProjectUppyUpload
                  projectId={projectId}
                  folderId={selectedFolderId}
                  onUpload={(files) => uploadFiles(files)}
                  isUploading={isUploading}
                  variant="dropcard"
                />
              }
            />
          )}
        </div>

      </div>

      {/*
        The model, when the URL names one. Full screen inside a popup — the
        page it opened from is still visible at the edges, which is what makes
        closing it feel like closing a preview rather than navigating back.
      */}
      {stageModel && (
        <ModelStage
          projectId={projectId}
          onClose={closeModel}
          // The viewport carries the same file operations as every other
          // document surface, so its renames and deletions have to land in this
          // page's corpus — otherwise closing the stage reveals a grid still
          // showing the old name, or a card for a building that is gone.
          onModelRenamed={handleRenamed}
          onModelDeleted={handleDeleted}
          canCollaborate={canCollaborate}
        />
      )}

    </div>
  )
}

/** One segment of the card/tree view toggle. */
export function ViewToggleButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: typeof LayoutGrid
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11',
        active ? 'bg-accent text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  )
}

/** Inline pane-level load failure with a retry affordance. */
function PaneLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTranslations('files')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <AlertCircle className="size-5 text-destructive" aria-hidden />
      <p className="text-sm text-muted-foreground text-balance">{message}</p>
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
        <RotateCcw className="size-3.5" aria-hidden />
        {t('workspace.tryAgain')}
      </Button>
    </div>
  )
}
