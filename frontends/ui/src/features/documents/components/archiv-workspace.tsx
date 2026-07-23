'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Archive, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import type { FileItem } from './project-file-workspace'
import { useArchivDocuments } from '../hooks/use-archiv-documents'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { ArchivLibraryPane } from './archiv-library-pane'
import { FilePreviewDialog } from './file-preview-dialog'
import { ProjectUppyUpload } from './project-uppy-upload'
import { ActiveUploads } from './active-uploads'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

interface ArchivWorkspaceProps {
  /** Whether the viewer may upload/delete (holds `org:archiv:manage`). */
  canManage: boolean
  /** Gates the ingestion-metadata block, mirroring the project Files tab. */
  showMetadataPanel?: boolean
}

/**
 * Gold Büroarchiv identity mark (spec §4, `--source-office`): icon + label
 * together so color is never the only carrier (a11y). Semantic tokens with
 * pre-retune fallbacks — no hex.
 */
const OFFICE_TINT: CSSProperties = {
  backgroundColor: 'var(--source-office-tint, var(--background-color-feedback-warning-subtle))',
  color: 'var(--source-office-text, var(--source-office, var(--text-color-feedback-warning)))',
}

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
 * ({@link ActiveUploads}) and the upload engine (via {@link useArchivDocuments})
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
  const { uploadFiles, isUploading, trackedFiles, error, clearError, retryFile } = useArchivDocuments({
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

  // Refetch the durable list when an upload batch settles.
  const wasUploading = useRef(false)
  useEffect(() => {
    if (wasUploading.current && !isUploading) void loadDocuments()
    wasUploading.current = isUploading
  }, [isUploading, loadDocuments])

  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null

  const handleReingested = useCallback((fileId: string, status: string) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, status, errorMessage: null } : f)))
  }, [])

  const handleTagsUpdated = useCallback((fileId: string, tags: string[]) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, tags } : f)))
  }, [])

  const handleDeleted = useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
    setSelectedFileId((current) => (current === fileId ? null : current))
  }, [])

  const activeUploads = useMemo(
    () =>
      trackedFiles.filter(
        (f) =>
          f.collectionName === collectionName &&
          f.file != null &&
          (f.status === 'uploading' || f.status === 'ingesting' || f.status === 'failed'),
      ),
    [trackedFiles, collectionName],
  )

  // Drag-and-drop routes into the same upload path the button uses (managers only).
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: uploadFiles,
    disabled: isUploading || !canManage,
  })

  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  const uploadButton = canManage ? (
    <ProjectUppyUpload onUpload={(f) => uploadFiles(f)} isUploading={isUploading} />
  ) : undefined

  return (
    <div className="relative flex h-full flex-col" {...(canManage ? dragHandlers : {})} data-testid="archiv-dropzone">
      {canManage && isDragging && (
        <div
          className={cn(
            'pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center',
            isUnsupportedDrag ? 'border-destructive bg-destructive/5' : 'border-ring bg-primary/5 backdrop-blur-sm',
          )}
          data-testid="archiv-drop-overlay"
        >
          <Upload className={cn('size-6', isUnsupportedDrag ? 'text-destructive' : 'text-primary')} aria-hidden />
          <p className={cn('text-sm font-medium', isUnsupportedDrag ? 'text-destructive' : 'text-primary')}>
            {isUnsupportedDrag ? t('workspace.dropUnsupported') : t('workspace.dropToUpload')}
          </p>
        </div>
      )}

      {/* Top action bar */}
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg"
            style={OFFICE_TINT}
            aria-hidden
          >
            <Archive className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{t('title')}</h2>
            <p className="truncate text-xs text-muted-foreground">{t('subtitle')}</p>
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
      <ActiveUploads files={activeUploads} onRetry={retryFile} />

      {/* Library grid; the preview opens in the shared centered-modal dialog. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="flex-1 overflow-y-auto">
          {loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
              <AlertCircle className="size-5 text-destructive" aria-hidden />
              <p className="text-sm text-muted-foreground text-balance">{t('workspace.loadError')}</p>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={loadDocuments}>
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
              />
            ) : undefined
          }
        />
      </div>
    </div>
  )
}

/**
 * Two-step Delete affordance for an Archiv document: the first click reveals an
 * inline Confirm/Cancel row so a stray tap can't purge a shared document.
 */
function DeleteDocumentButton({
  fileId,
  filename,
  onDeleted,
}: {
  fileId: string
  filename: string
  onDeleted: (fileId: string) => void
}) {
  const t = useTranslations('archiv')
  const [confirming, setConfirming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/archiv/documents/${fileId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`)
      toast.success(t('delete.success', { name: filename }))
      onDeleted(fileId)
    } catch {
      toast.error(t('delete.error'))
      setIsDeleting(false)
      setConfirming(false)
    }
  }, [fileId, filename, onDeleted, t])

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="mt-2 w-full gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="size-4" aria-hidden />
        {t('delete.action')}
      </Button>
    )
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-xs text-muted-foreground">{t('delete.confirm')}</p>
      <div className="flex gap-2">
        <Button type="button" variant="destructive" size="sm" className="flex-1 gap-1.5" onClick={handleDelete} disabled={isDeleting}>
          <Trash2 className="size-3.5" aria-hidden />
          {isDeleting ? t('delete.deleting') : t('delete.confirmAction')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={isDeleting}>
          {t('delete.cancel')}
        </Button>
      </div>
    </div>
  )
}
