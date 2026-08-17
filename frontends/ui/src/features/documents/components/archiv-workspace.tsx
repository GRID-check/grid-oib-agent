'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { sourceBase, sourceTint } from '@/lib/ui/source-tint'
import { AlertCircle, Archive, RotateCcw, X } from 'lucide-react'
import type { FileItem } from './project-file-workspace'
import { useArchivDocuments } from '../hooks/use-archiv-documents'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { useIngestionCompleteToast } from '../hooks/use-ingestion-complete-toast'
import { useSettlingRefresh } from '../hooks/use-settling-refresh'
import { ArchivLibraryPane } from './archiv-library-pane'
import { DocumentActionsMenu } from './document-actions'
import { FilePreviewDialog } from './file-preview-dialog'
import { FileDropOverlay, useWindowDragGuard } from './file-drop-overlay'
import { ProjectUppyUpload } from './project-uppy-upload'
import { UploadTray } from './upload-tray'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'

interface ArchivWorkspaceProps {
  /** Whether the viewer may upload/delete (holds `org:archiv:manage`). */
  canManage: boolean
  /** Gates the ingestion-metadata block, mirroring the project Files tab. */
  showMetadataPanel?: boolean
}

/**
 * Gold Büroarchiv identity mark (spec §4, `--source-office`): icon + label
 * together so color is never the only carrier (a11y).
 */
const OFFICE_TINT = sourceTint('office')

interface ArchivListResponse {
  documents?: Array<Record<string, unknown>>
  collectionName?: string
  canManage?: boolean
}

/**
 * Org-wide Archiv workspace — the cross-project counterpart to
 * {@link import('./project-file-workspace').ProjectFileWorkspace}. The listing
 * is the curated {@link ArchivLibraryPane} (card grid + category chips over the
 * real ingestion tags, WS-6); preview ({@link FilePreviewPane}), upload progress
 * ({@link UploadTray}) and the upload engine (via {@link useArchivDocuments})
 * are shared with the project Files workspace. Only the data source
 * (`/api/archiv/documents`), the flat (folder-less) layout, and the org-level
 * authorization differ. Members without manage rights get a read-only view
 * (list + preview + download).
 */
export function ArchivWorkspace({ canManage, showMetadataPanel = true }: ArchivWorkspaceProps) {
  const t = useTranslations('archiv')
  const [files, setFiles] = useState<FileItem[]>([])
  const [collectionName, setCollectionName] = useState<string | undefined>(undefined)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

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
   * win, whatever order the responses come back in.
   */
  const loadGeneration = useRef(0)

  /**
   * @param quiet Refresh without the skeleton — used by the settling poll
   *   below, which would otherwise flash the whole grid every few seconds.
   */
  const loadDocuments = useCallback((quiet = false) => {
    const generation = ++loadGeneration.current
    const isStale = () => generation !== loadGeneration.current
    if (!quiet) setIsLoading(true)
    setLoadError(false)
    return fetch('/api/archiv/documents')
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load Archiv (${r.status})`)
        return r.json() as Promise<ArchivListResponse>
      })
      .then((data) => {
        if (isStale()) return
        setCollectionName(data.collectionName)
        const docs: FileItem[] = (data.documents ?? []).map((d) => ({
          id: d.id as string,
          filename: d.filename as string,
          displayName: (d.displayName as string | null) ?? null,
          fileSize: (d.fileSize as number | null) ?? null,
          contentType: (d.contentType as string | null) ?? null,
          status: (d.status as string | null) ?? null,
          folderId: null,
          createdAt: d.createdAt as string,
          errorMessage: (d.errorMessage as string | null) ?? null,
          summary: (d.summary as string | null) ?? null,
          pageCount: (d.pageCount as number | null) ?? null,
          chunkCount: (d.chunkCount as number | null) ?? null,
          contentTypes: (d.contentTypes as string[] | null) ?? null,
          tags: (d.tags as string[] | null) ?? null,
        }))
        setFiles(docs)
      })
      .catch(() => {
        // A failed POLL must not empty a list the user is looking at; only a
        // foreground load owns the error state — and only while it is still the
        // latest one, so a late failure cannot blank a newer successful list.
        if (quiet || isStale()) return
        setFiles([])
        setLoadError(true)
      })
      .finally(() => {
        // Deliberately NOT generation-guarded: the spinner belongs to the
        // foreground loads alone, and a quiet poll starting mid-load would
        // otherwise leave it spinning forever with nobody left to clear it.
        if (!quiet) setIsLoading(false)
      })
  }, [])

  useEffect(() => {
    void loadDocuments()
  }, [loadDocuments])

  // Only managers drive the upload engine; passing an undefined collection to a
  // read-only viewer keeps useFileUpload's orchestrator effects inert (no
  // background collection-proxy calls that would 403 for them anyway).
  const {
    uploadFiles,
    isUploading,
    trackedFiles,
    error,
    clearError,
    retryFile,
    cancelFile,
    cancelUpload,
    dismissFiles,
  } = useArchivDocuments({
    collectionName: canManage ? collectionName : undefined,
    // Wrapped rather than passed directly: `loadDocuments` takes a `quiet`
    // flag now, and whatever the orchestrator hands its callback must not
    // decide how this renders.
    onComplete: () => void loadDocuments(),
  })

  // Surface hook errors as a transient toast (plus the persistent inline Alert).
  const lastToastedError = useRef<string | null>(null)
  useEffect(() => {
    if (error && error !== lastToastedError.current) {
      lastToastedError.current = error
      toast.error(error)
    }
    if (!error) lastToastedError.current = null
  }, [error])

  // Confirm the instant a document finishes async ingestion and becomes citable.
  // Provenance-correct for the office Archiv — gold + archive-box icon (spec §4,
  // color never travels alone). Fires once per newly-completed file.
  useIngestionCompleteToast(
    files,
    useCallback(
      (file: FileItem) => {
        toast.success(t('toast.ingestionComplete', { name: documentDisplayName(file) }), {
          icon: <Archive className="size-4" style={{ color: sourceBase('office') }} aria-hidden />,
        })
      },
      [t]
    )
  )

  /*
    Re-ask while anything is still being read.

    `onComplete` fires when the BYTES land, which for an `.ifc` is the moment
    extraction STARTS: `beginModelExtraction` returns no job id, so the upload
    orchestrator never watches a model and nothing else here would ever ask
    again. Without this poll every model uploaded through Archiv sat at "Wird
    gelesen…" until the page was reloaded, and the completion toast below never
    fired at all. Same hook, same guarantees, as the project Files workspace.
  */
  useSettlingRefresh(files, loadDocuments)

  // Refetch the durable list when an upload batch settles.
  const wasUploading = useRef(false)
  useEffect(() => {
    if (wasUploading.current && !isUploading) void loadDocuments()
    wasUploading.current = isUploading
  }, [isUploading, loadDocuments])

  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null

  const handleReingested = useCallback((fileId: string, status: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status, errorMessage: null } : f))
    )
  }, [])

  const handleTagsUpdated = useCallback((fileId: string, tags: string[]) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, tags } : f)))
  }, [])

  const handleDeleted = useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
    setSelectedFileId((current) => (current === fileId ? null : current))
  }, [])

  // A rename lands in the local corpus from the PATCH's own answer, so the
  // library card and the preview header carry the new name in the same frame
  // the dialog closes — no refetch of the whole Archiv for one string.
  const handleRenamed = useCallback((fileId: string, displayName: string | null) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, displayName } : f)))
  }, [])

  // This session's own uploads, in every phase — see the same selector in
  // ProjectFileWorkspace for why settled rows stay until dismissed.
  const activeUploads = useMemo(
    () => trackedFiles.filter((f) => f.collectionName === collectionName && f.file != null),
    [trackedFiles, collectionName]
  )

  // Drag-and-drop routes into the same upload path the button uses (managers only).
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: uploadFiles,
    disabled: isUploading || !canManage,
  })

  useWindowDragGuard()

  const uploadButton = canManage ? (
    <ProjectUppyUpload onUpload={(f) => uploadFiles(f)} isUploading={isUploading} />
  ) : undefined

  return (
    <div
      className="relative flex h-full flex-col"
      {...(canManage ? dragHandlers : {})}
      data-testid="archiv-dropzone"
    >
      {canManage && isDragging && (
        <FileDropOverlay
          isUnsupported={isUnsupportedDrag}
          uploadLabel={t('workspace.dropToUpload')}
          unsupportedLabel={t('workspace.dropUnsupported')}
          testId="archiv-drop-overlay"
        />
      )}

      {/* Identity row — the gold Büroarchiv mark, the name of the store, and how
          much is in it. The count sits with the title rather than in the grid:
          it is a property of the Archiv, and it is the one number a reader wants
          before they start filtering. */}
      <div className="flex min-h-[4rem] items-center justify-between gap-4 border-b px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="shadow-2xs flex size-9 shrink-0 items-center justify-center rounded-xl"
            style={OFFICE_TINT}
            aria-hidden
          >
            <Archive className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-foreground truncate text-[15px] font-semibold tracking-tight">
                {t('title')}
              </h2>
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center">
                {!isLoading && !loadError && files.length > 0 && (
                  <CountPill data-testid="archiv-document-count">{files.length}</CountPill>
                )}
              </span>
            </div>
            <p className="text-muted-foreground truncate text-xs">{t('subtitle')}</p>
          </div>
        </div>
        {uploadButton}
      </div>

      {/* Error banner */}
      {error && (
        <div className="border-b px-4 py-3 animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none">
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

      {/* Library grid; the preview opens in the shared centered-modal dialog. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {/* The last row of cards dissolves at the bottom edge instead of being
            clipped through the middle of a filename — the shared scroll-boundary
            treatment (design language, "Scroll boundaries"). */}
        <div className="scroll-fade-bottom min-h-0 min-w-0 flex-1 overflow-y-auto">
          {loadError ? (
            <EmptyState
              variant="bare"
              icon={AlertCircle}
              title={t('workspace.loadError')}
              className="h-full justify-center"
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  // Not `onClick={loadDocuments}`: the click event would arrive as
                  // the `quiet` flag, so a retry would hide its own skeleton and
                  // swallow a second failure.
                  onClick={() => void loadDocuments()}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  {t('workspace.tryAgain')}
                </Button>
              }
            />
          ) : (
            <ArchivLibraryPane
              files={files}
              selectedFileId={selectedFileId}
              onSelectFile={setSelectedFileId}
              isLoading={isLoading}
              uploadControl={uploadButton}
              renderActions={(file) => (
                <DocumentActionsMenu
                  document={file}
                  scope="archiv"
                  canManage={canManage}
                  onRenamed={handleRenamed}
                  onDeleted={handleDeleted}
                />
              )}
            />
          )}
        </div>

        {/* The file operations live in the preview's header now. `canManage`
            still decides whether they are offered at all: a member without
            `org:archiv:manage` keeps download and sees no rename or delete. */}
        <FilePreviewDialog
          file={selectedFile}
          canManage={canManage}
          scope="archiv"
          onClose={() => setSelectedFileId(null)}
          onReingested={handleReingested}
          onTagsUpdated={handleTagsUpdated}
          onRenamed={handleRenamed}
          onDeleted={handleDeleted}
          showMetadataPanel={showMetadataPanel}
        />
      </div>
    </div>
  )
}
