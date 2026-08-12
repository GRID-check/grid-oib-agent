'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { sourceBase, sourceTint } from '@/lib/ui/source-tint'
import { AlertCircle, Archive, RotateCcw, X } from 'lucide-react'
import type { FileItem } from './project-file-workspace'
import { useArchivDocuments } from '../hooks/use-archiv-documents'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { useIngestionCompleteToast } from '../hooks/use-ingestion-complete-toast'
import { ArchivLibraryPane } from './archiv-library-pane'
import { FilePreviewDialog } from './file-preview-dialog'
import { DeleteDocumentButton } from './delete-document-button'
import { FileDropOverlay, useWindowDragGuard } from './file-drop-overlay'
import { ProjectUppyUpload } from './project-uppy-upload'
import { UploadTray } from './upload-tray'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { useTranslations } from '@/i18n'

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

  const loadDocuments = useCallback(() => {
    setIsLoading(true)
    setLoadError(false)
    return fetch('/api/archiv/documents')
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load Archiv (${r.status})`)
        return r.json() as Promise<ArchivListResponse>
      })
      .then((data) => {
        setCollectionName(data.collectionName)
        const docs: FileItem[] = (data.documents ?? []).map((d) => ({
          id: d.id as string,
          filename: d.filename as string,
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
        setFiles([])
        setLoadError(true)
      })
      .finally(() => setIsLoading(false))
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
    onComplete: loadDocuments,
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
        toast.success(t('toast.ingestionComplete', { name: file.filename }), {
          icon: <Archive className="size-4" style={{ color: sourceBase('office') }} aria-hidden />,
        })
      },
      [t]
    )
  )

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
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3.5">
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
              {!isLoading && !loadError && files.length > 0 && (
                <CountPill data-testid="archiv-document-count">{files.length}</CountPill>
              )}
            </div>
            <p className="text-muted-foreground truncate text-xs">{t('subtitle')}</p>
          </div>
        </div>
        {uploadButton}
      </div>

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

      {/* Library grid; the preview opens in the shared centered-modal dialog. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* The last row of cards dissolves at the bottom edge instead of being
            clipped through the middle of a filename — the shared scroll-boundary
            treatment (design language, "Scroll boundaries"). */}
        <div className="scroll-fade-bottom flex-1 overflow-y-auto">
          {loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
              <AlertCircle className="text-destructive size-5" aria-hidden />
              <p className="text-muted-foreground text-balance text-sm">
                {t('workspace.loadError')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={loadDocuments}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {t('workspace.tryAgain')}
              </Button>
            </div>
          ) : (
            <ArchivLibraryPane
              files={files}
              selectedFileId={selectedFileId}
              onSelectFile={setSelectedFileId}
              isLoading={isLoading}
              uploadControl={uploadButton}
            />
          )}
        </div>

        <FilePreviewDialog
          file={selectedFile}
          canManage={canManage}
          onClose={() => setSelectedFileId(null)}
          onReingested={handleReingested}
          onTagsUpdated={handleTagsUpdated}
          showMetadataPanel={showMetadataPanel}
          extraActions={
            canManage && selectedFile ? (
              <DeleteDocumentButton
                fileId={selectedFile.id}
                filename={selectedFile.filename}
                onDeleted={handleDeleted}
                deleteUrl={`/api/archiv/documents/${selectedFile.id}`}
                namespace="archiv"
              />
            ) : undefined
          }
        />
      </div>
    </div>
  )
}
