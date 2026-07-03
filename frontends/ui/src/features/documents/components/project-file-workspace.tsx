// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { AlertCircle, ShieldCheck, X } from 'lucide-react'
import { useProjectDocuments } from '../hooks/use-project-documents'
import { FolderTreePane } from './folder-tree-pane'
import { FileBrowserPane } from './file-browser-pane'
import { FilePreviewPane } from './file-preview-pane'
import { ProjectUppyUpload } from './project-uppy-upload'
import { ActiveUploads } from './active-uploads'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

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
}

export function ProjectFileWorkspace({ projectId, projectName, collectionName }: ProjectFileWorkspaceProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [files, setFiles] = useState<FileItem[]>([])
  const [isLoadingFolders, setIsLoadingFolders] = useState(true)
  const [isLoadingFiles, setIsLoadingFiles] = useState(true)

  const loadFiles = useCallback(() => {
    setIsLoadingFiles(true)
    const params = new URLSearchParams({ projectId })
    return fetch(`/api/documents?${params}`)
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((data) => {
        const docs: FileItem[] = (data.documents ?? []).map((d: any) => ({
          id: d.id,
          filename: d.filename,
          fileSize: d.fileSize,
          contentType: d.contentType,
          status: d.status,
          folderId: d.folderId ?? null,
          createdAt: d.createdAt,
        }))
        setFiles(docs)
      })
      .catch(() => setFiles([]))
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
  useEffect(() => {
    setIsLoadingFolders(true)
    fetch(`/api/projects/${projectId}/folders`)
      .then((r) => (r.ok ? r.json() : { folders: [] }))
      .then((data) => setFolders(data.folders ?? []))
      .catch(() => setFolders([]))
      .finally(() => setIsLoadingFolders(false))
  }, [projectId])

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
        toast.error('Could not create folder. Please try again.')
      }
      return res.ok
    },
    [projectId]
  )

  return (
    <div className="flex h-full flex-col">
      {/* Top action bar */}
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{projectName}</h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
            Project corpus — these documents ground Grid&rsquo;s answers
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
            <AlertTitle>Upload problem</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 size-6"
              onClick={clearError}
              aria-label="Dismiss error"
            >
              <X className="size-4" />
            </Button>
          </Alert>
        </div>
      )}

      {/* Live upload progress */}
      <ActiveUploads files={activeUploads} onRetry={retryFile} />

      {/* Three-pane layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Folder tree */}
        <div className="w-60 shrink-0 overflow-y-auto border-r">
          <FolderTreePane
            folders={folders}
            selectedFolderId={selectedFolderId}
            onSelectFolder={setSelectedFolderId}
            onCreateFolder={handleCreateFolder}
            isLoading={isLoadingFolders}
          />
        </div>

        {/* File browser */}
        <div className="flex-1 overflow-y-auto">
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
                label="Upload documents"
              />
            }
          />
        </div>

        {/* Preview pane */}
        {selectedFile && (
          <div className="w-96 shrink-0 overflow-y-auto border-l">
            <FilePreviewPane file={selectedFile} projectId={projectId} onClose={() => setSelectedFileId(null)} />
          </div>
        )}
      </div>
    </div>
  )
}
