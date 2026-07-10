'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { AlertCircle, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useProjectDocuments } from '../hooks/use-project-documents'
import { FolderTreePane } from './folder-tree-pane'
import { FileBrowserPane } from './file-browser-pane'
import { FilePreviewPane } from './file-preview-pane'
import { ProjectUppyUpload } from './project-uppy-upload'
import { ActiveUploads } from './active-uploads'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'

interface ProjectFileWorkspaceProps {
  projectId: string
  projectName: string
  collectionName: string
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
}

export function ProjectFileWorkspace({ projectId, projectName, collectionName }: ProjectFileWorkspaceProps) {
  const t = useTranslations('files')
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

  // After a successful re-ingestion the document is back to 'pending'; reflect
  // that locally so the badge flips to "Processing" and the dead-end failure UI
  // clears. Server-side reconciliation resolves the final status on the next read.
  const handleReingested = useCallback((fileId: string, status: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status, errorMessage: null } : f))
    )
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
    <div className="flex h-full flex-col">
      {/* Top action bar */}
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{projectName}</h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
            {t('workspace.corpusSubtitle')}
          </p>
        </div>
        <ProjectUppyUpload
          projectId={projectId}
          folderId={selectedFolderId}
          onUpload={(files) => uploadFiles(files)}
          isUploading={isUploading}
        />
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
        {/* Folder tree */}
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
            />
          )}
        </div>

        {/* Preview pane — full-screen overlay on mobile, docked column on md+ */}
        {selectedFile && (
          <div className="fixed inset-0 z-50 w-full shrink-0 overflow-y-auto bg-background pt-[env(safe-area-inset-top)] md:static md:z-auto md:w-96 md:border-l md:pt-0">
            <FilePreviewPane
              file={selectedFile}
              projectId={projectId}
              onClose={() => setSelectedFileId(null)}
              onReingested={handleReingested}
            />
          </div>
        )}
      </div>
    </div>
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
