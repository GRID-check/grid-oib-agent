'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { AlertCircle, LayoutGrid, ListTree, RotateCcw, ShieldCheck, Trash2, Upload, X } from 'lucide-react'
import { useProjectDocuments } from '../hooks/use-project-documents'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { FolderTreePane } from './folder-tree-pane'
import { FileBrowserPane } from './file-browser-pane'
import { FilePreviewPane } from './file-preview-pane'
import { ProjectUppyUpload } from './project-uppy-upload'
import { ActiveUploads } from './active-uploads'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

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
}

export interface FolderItem {
  id: string
  parentId: string | null
  name: string
  path: string
}

export interface FileItem {
  id: string
  filename: string
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
}

/** Presentation of the file browser: the dummy's card grid, or the folder tree. */
type FileView = 'cards' | 'tree'
const VIEW_STORAGE_KEY = 'grid.files.view'

export function ProjectFileWorkspace({ projectId, projectName, collectionName, showMetadataPanel = true }: ProjectFileWorkspaceProps) {
  const t = useTranslations('files')
  // Default to the card grid (the click-dummy). The folder-tree workspace stays
  // one click away and the choice persists per browser (sidebar-collapse pattern).
  const [view, setView] = useState<FileView>('cards')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY)
    if (stored === 'cards' || stored === 'tree') setView(stored)
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

  const loadFiles = useCallback(() => {
    setIsLoadingFiles(true)
    setFilesError(false)
    const params = new URLSearchParams({ projectId })
    return fetch(`/api/documents?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load documents (${r.status})`)
        return r.json()
      })
      .then((data) => {
        const docs: FileItem[] = (data.documents ?? []).map((d: any) => ({
          id: d.id,
          filename: d.filename,
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
        }))
        setFiles(docs)
      })
      .catch(() => {
        setFiles([])
        setFilesError(true)
      })
      .finally(() => setIsLoadingFiles(false))
  }, [projectId])

  const { uploadFiles, isUploading, trackedFiles, error, clearError, retryFile } = useProjectDocuments({
    projectId,
    folderId: selectedFolderId ?? undefined,
    // Refresh the durable file list once ingestion of an upload completes so new
    // documents appear without a manual reload.
    onComplete: loadFiles,
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

  // Refetch the corpus when an upload batch settles (covers non-orchestrated paths).
  const wasUploading = useRef(false)
  useEffect(() => {
    if (wasUploading.current && !isUploading) {
      void loadFiles()
    }
    wasUploading.current = isUploading
  }, [isUploading, loadFiles])

  const filteredFiles = useMemo(
    () => (selectedFolderId ? files.filter((f) => f.folderId === selectedFolderId) : files),
    [files, selectedFolderId]
  )

  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null

  // The preview is a centered modal overlay (matching the click-dummy) on every
  // breakpoint: dialog semantics, Escape-to-close, backdrop click, and focus
  // return to the file card that opened it.
  const previewOpen = selectedFile !== null
  const previousFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!previewOpen) return
    // Remember the file row that opened the overlay so focus can return to it.
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedFileId(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocusRef.current?.focus?.()
    }
  }, [previewOpen])

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

  // In-flight and failed uploads for this project's corpus only.
  const activeUploads = useMemo(
    () =>
      trackedFiles.filter(
        (f) =>
          f.collectionName === collectionName &&
          f.file != null &&
          (f.status === 'uploading' || f.status === 'ingesting' || f.status === 'failed')
      ),
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
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      e.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

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
        <div
          className={cn(
            'pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center',
            isUnsupportedDrag
              ? 'border-destructive bg-destructive/5'
              : 'border-ring bg-primary/5 backdrop-blur-sm'
          )}
          data-testid="workspace-drop-overlay"
        >
          <Upload
            className={cn('size-6', isUnsupportedDrag ? 'text-destructive' : 'text-primary')}
            aria-hidden
          />
          <p className={cn('text-sm font-medium', isUnsupportedDrag ? 'text-destructive' : 'text-primary')}>
            {isUnsupportedDrag ? t('workspace.dropUnsupported') : t('workspace.dropToUpload')}
          </p>
        </div>
      )}

      {/* Top action bar */}
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{projectName}</h2>
          {/* The corpus subtitle is helpful context but costs 2–3 wrapped lines
              on a phone; hide it below sm to keep the action bar to one row. */}
          <p className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
            {t('workspace.corpusSubtitle')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Card grid (dummy default) ⟷ folder-tree workspace toggle. */}
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
              active={view === 'tree'}
              onClick={() => selectView('tree')}
              label={t('workspace.view.tree')}
              icon={ListTree}
            />
          </div>
          <ProjectUppyUpload
            projectId={projectId}
            folderId={selectedFolderId}
            onUpload={(files) => uploadFiles(files)}
            isUploading={isUploading}
          />
        </div>
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

      {/* Three-pane layout — stacks on mobile: folders on top, files below,
          preview as a full-screen overlay. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* Folder tree — only in the tree view; the card view navigates folders
            through the chip row instead. All tree functionality (expand/collapse,
            selection, drill-in, create) is preserved. */}
        {view === 'tree' && (
          <div className="max-h-48 w-full shrink-0 overflow-y-auto border-b md:max-h-none md:w-60 md:border-b-0 md:border-r">
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
              onSelectFile={setSelectedFileId}
              isLoading={isLoadingFiles}
              hasFolderSelected={selectedFolderId !== null}
              projectId={projectId}
              {...(view === 'cards'
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

      {/* Preview — centered modal overlay (click-dummy), backdrop dims the page
          and closes on click; the panel maxes at 920px with the split preview. */}
      {selectedFile && (
        <div
          role="dialog"
          aria-modal
          aria-label={t('preview.dialogLabel', { name: selectedFile.filename })}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 pt-[max(1rem,env(safe-area-inset-top))] md:p-10"
          onClick={() => setSelectedFileId(null)}
        >
          <div
            className="flex max-h-full w-full max-w-[920px] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <FilePreviewPane
              file={selectedFile}
              projectId={projectId}
              projectName={projectName}
              onClose={() => setSelectedFileId(null)}
              onReingested={handleReingested}
              onTagsUpdated={handleTagsUpdated}
              showMetadataPanel={showMetadataPanel}
              extraActions={
                <DeleteDocumentButton
                  fileId={selectedFile.id}
                  filename={selectedFile.filename}
                  onDeleted={handleDeleted}
                />
              }
            />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Two-step Delete affordance for a project document: the first click reveals an
 * inline Confirm/Cancel row so a stray tap can't purge a document. Mirrors the
 * Archiv workspace's DeleteDocumentButton; deletion goes through the project
 * document route (`DELETE /api/documents/{id}`), which enforces `project:edit`.
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
  const t = useTranslations('files')
  const [confirming, setConfirming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/documents/${fileId}`, { method: 'DELETE' })
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
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="flex-1 gap-1.5"
          onClick={handleDelete}
          disabled={isDeleting}
        >
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

/** One segment of the card/tree view toggle. */
function ViewToggleButton({
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
        'flex size-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
