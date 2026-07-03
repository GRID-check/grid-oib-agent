// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect } from 'react'
import { useProjectDocuments } from '../hooks/use-project-documents'
import { FolderTreePane } from './folder-tree-pane'
import { FileBrowserPane } from './file-browser-pane'
import { FilePreviewPane } from './file-preview-pane'
import { ProjectUppyUpload } from './project-uppy-upload'

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

  const { uploadFiles, isUploading, trackedFiles } = useProjectDocuments({
    projectId,
    folderId: selectedFolderId ?? undefined,
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

  // Fetch files (filtered by folder if selected)
  useEffect(() => {
    setIsLoadingFiles(true)
    const params = new URLSearchParams({ projectId })
    fetch(`/api/documents?${params}`)
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

  const filteredFiles = selectedFolderId
    ? files.filter((f) => f.folderId === selectedFolderId)
    : files

  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null

  const handleCreateFolder = useCallback(async (name: string, parentId?: string) => {
    const res = await fetch(`/api/projects/${projectId}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId }),
    })
    if (res.ok) {
      const data = await res.json()
      setFolders((prev) => [...prev, data.folder])
    }
    return res.ok
  }, [projectId])

  return (
    <div className="flex h-full flex-col">
      {/* Top action bar */}
      <div className="flex items-center justify-between border-b border-base px-4 py-3">
        <h2 className="text-sm font-medium text-subtle">{projectName} / Files</h2>
        <ProjectUppyUpload
          projectId={projectId}
          folderId={selectedFolderId}
          onUpload={(files) => uploadFiles(files)}
          isUploading={isUploading}
        />
      </div>

      {/* Three-pane layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Folder tree */}
        <div className="w-60 shrink-0 border-r border-base overflow-y-auto">
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
          />
        </div>

        {/* Preview pane */}
        {selectedFile && (
          <div className="w-96 shrink-0 border-l border-base overflow-y-auto">
            <FilePreviewPane file={selectedFile} projectId={projectId} />
          </div>
        )}
      </div>
    </div>
  )
}
