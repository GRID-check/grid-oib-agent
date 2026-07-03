// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * FileSourcesTab Component
 *
 * Content for the "File Sources" tab in the DataSourcePanel.
 * Displays a list of uploaded file sources with their status.
 * Integrates with file upload system for real-time progress tracking.
 */

'use client'

import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { Flex, Text, Button, Banner } from '@/adapters/ui'
import { LoadingSpinner } from '@/adapters/ui/icons'
import { FileSourceCard } from './FileSourceCard'
import { DeleteFileConfirmationModal } from './DeleteFileConfirmationModal'
import {
  useFileUpload,
  useDocumentsStore,
  FileUploadZone,
  mapToDisplayStatus,
} from '@/features/documents'
import { sessionHasKnownCollection } from '@/features/documents/persistence'
import { useChatStore } from '@/features/chat/store'
import { useLayoutStore } from '../store'
import { useAppConfig } from '@/shared/context'

interface FileSourcesTabProps {
  /** Callback when a file is deleted */
  onDeleteFile?: (id: string) => void
}

/**
 * Tab content showing list of uploaded file sources.
 * Connected to the file upload store for real-time updates.
 */
export const FileSourcesTab: FC<FileSourcesTabProps> = ({ onDeleteFile }) => {
  // Get current conversation and ensureSession for session management
  const currentConversation = useChatStore((state) => state.currentConversation)
  const ensureSession = useChatStore((state) => state.ensureSession)
  const projectId = useChatStore((state) => state.projectId)
  const [uploadTarget, setUploadTarget] = useState<'project' | 'session'>(projectId ? 'project' : 'session')
  const [projectCollectionName, setProjectCollectionName] = useState<string | undefined>(undefined)

  // Check if file uploads are available (knowledge layer)
  const knowledgeLayerAvailable = useLayoutStore((state) => state.knowledgeLayerAvailable)

  // Get file upload configuration from app config
  const { fileUpload: fileUploadConfig } = useAppConfig()

  useEffect(() => {
    if (!projectId) {
      setUploadTarget('session')
      setProjectCollectionName(undefined)
      return
    }

    let cancelled = false
    setUploadTarget('project')

    fetch(`/api/projects/${projectId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((project: { collectionName?: string } | null) => {
        if (!cancelled) {
          setProjectCollectionName(project?.collectionName)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectCollectionName(undefined)
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  const isProjectTarget = uploadTarget === 'project' && !!projectId
  const isProjectTargetReady = isProjectTarget && !!projectCollectionName
  const targetCollectionName = isProjectTarget ? projectCollectionName : currentConversation?.id
  const targetProjectId = isProjectTargetReady ? projectId : undefined

  // File upload hook - provides target files and handles validation internally
  const {
    uploadFiles,
    deleteFile,
    sessionFiles: targetFiles,
    isUploading,
    isPolling,
    error: uploadError,
    clearError,
  } = useFileUpload({
    collectionName: targetCollectionName,
    projectId: targetProjectId,
  })

  // The documents store's currentCollectionName tells us WHICH session is actively being processed.
  // isUploading/isPolling are global flags, so we must scope to the current session to avoid
  // showing a spinner for uploads belonging to a different session.
  const activeCollection = useDocumentsStore((state) => state.currentCollectionName)
  const isLoadingFiles = useDocumentsStore((state) => state.isLoadingFiles)
  const loadedSessionId = useDocumentsStore((state) => state.loadedSessionId)
  const isThisSessionProcessing =
    activeCollection === targetCollectionName && (isUploading || isPolling)

  // Show spinner when:
  // 1. Actively loading files from server, OR
  // 2. Upload/polling in progress but files haven't appeared, OR
  // 3. Session is known to have files but we haven't loaded for it yet
  //    (covers the render-to-useEffect gap on session switch; stops once
  //    loadFilesForSession completes — even if the result is empty)
  const sessionId = targetCollectionName
  const hasLoadedForSession = loadedSessionId === sessionId
  const sessionExpectsFiles =
    !!sessionId && !hasLoadedForSession && sessionHasKnownCollection(sessionId)
  const isAwaitingFiles =
    isLoadingFiles || (isThisSessionProcessing && targetFiles.length === 0) || sessionExpectsFiles

  const uploadTargetLabel = isProjectTarget ? 'Project corpus' : 'Private session'
  const uploadDisabled = isUploading || (isProjectTarget && !projectCollectionName)

  // Delete confirmation modal state
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [fileIdToDelete, setFileIdToDelete] = useState<string | null>(null)

  /**
   * Handle file upload with session auto-creation.
   * Validation is handled internally by uploadFiles.
   */
  const handleUpload = useCallback(
    async (files: File[]) => {
      if (isProjectTarget && !projectCollectionName) {
        console.error('Project collection is not ready for upload')
        return
      }
      if (!isProjectTarget && !ensureSession()) {
        console.error('Failed to create session for upload')
        return
      }
      // uploadFiles validates internally and sets error if invalid
      await uploadFiles(files)
    },
    [ensureSession, isProjectTarget, projectCollectionName, uploadFiles]
  )

  // Hidden file input ref
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Handle Add File button click
  const handleAddFileClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // Handle file input change
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length > 0) {
        handleUpload(files)
      }
      // Reset input so same file can be selected again
      e.target.value = ''
    },
    [handleUpload]
  )

  // Opens the delete confirmation modal
  const handleDeleteClick = useCallback((id: string) => {
    setFileIdToDelete(id)
    setIsDeleteModalOpen(true)
  }, [])

  // Actually performs the delete after confirmation
  const handleConfirmDelete = useCallback(async () => {
    if (fileIdToDelete) {
      await deleteFile(fileIdToDelete)
      onDeleteFile?.(fileIdToDelete)
      setFileIdToDelete(null)
    }
  }, [fileIdToDelete, deleteFile, onDeleteFile])

  // Handles modal close/cancel
  const handleModalOpenChange = useCallback((open: boolean) => {
    setIsDeleteModalOpen(open)
    if (!open) {
      setFileIdToDelete(null)
    }
  }, [])

  const uploadTargetControls = projectId ? (
    <Flex direction="col" gap="2" className="rounded-xl border border-subtle bg-surface-2 p-3">
      <Text kind="label/semibold/xs" className="text-subtle uppercase">
        Upload To
      </Text>
      <Flex gap="2">
        <Button
          kind={uploadTarget === 'project' ? 'primary' : 'secondary'}
          size="small"
          onClick={() => setUploadTarget('project')}
          disabled={!projectCollectionName}
        >
          Project corpus
        </Button>
        <Button
          kind={uploadTarget === 'session' ? 'primary' : 'secondary'}
          size="small"
          onClick={() => setUploadTarget('session')}
        >
          Private session
        </Button>
      </Flex>
      <Text kind="body/regular/xs" className="text-subtle">
        {isProjectTarget
          ? projectCollectionName
            ? 'Available in this project.'
            : 'Preparing project corpus...'
          : 'Only available in this chat session.'}
      </Text>
    </Flex>
  ) : null

  if (targetFiles.length === 0) {
    // When files are expected (loading, uploading, or session known to have files),
    // always show the spinner — never flash "No Files" during transitions.
    if (isAwaitingFiles) {
      return (
        <Flex direction="col" align="center" justify="center" gap="2" className="flex-1 py-8">
          <LoadingSpinner size="medium" aria-label="Loading files" />
          <Text kind="body/regular/sm" className="text-subtle">
            Checking for files...
          </Text>
        </Flex>
      )
    }

    return (
      <Flex direction="col" gap="4" className="flex-1">
        {/* Show info banner when file upload is not available */}
        {uploadTargetControls}

        {!knowledgeLayerAvailable && (
          <Banner kind="inline" status="info" className="mb-6 px-4 py-3">
            Setup backend to enable files.
          </Banner>
        )}

        {/* Show empty state message when file upload is available */}
        {knowledgeLayerAvailable && (
          <Flex direction="col" gap="1">
            <Text kind="label/semibold/xs" className="text-subtle uppercase">
              No Attached Files
            </Text>
            <Text kind="body/regular/sm" className="text-subtle">
              Files uploaded here go to {uploadTargetLabel.toLowerCase()} unless removed.
            </Text>
          </Flex>
        )}

        {/* Upload Error Display */}
        {uploadError && (
          <Banner kind="inline" status="error" onClose={clearError}>
            {uploadError}
          </Banner>
        )}

        {/* File Upload Zone */}
        {knowledgeLayerAvailable && (
          <FileUploadZone
            collectionName={targetCollectionName}
            acceptedTypes={fileUploadConfig.acceptedTypes}
            maxFileSize={fileUploadConfig.maxFileSize}
            onUpload={handleUpload}
            isUploading={uploadDisabled}
          />
        )}
      </Flex>
    )
  }

  return (
    <Flex direction="col" gap="2" className="flex-1 overflow-y-auto">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={fileUploadConfig.acceptedTypes}
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Upload Error Display */}
      {uploadError && (
        <Banner kind="inline" status="error" onClose={clearError}>
          {uploadError}
        </Banner>
      )}

      {/* Header with count and add button */}
      {uploadTargetControls}

      <Flex align="center" justify="between" className="mb-1">
        <Text kind="label/semibold/xs" className="text-subtle uppercase">
          {uploadTargetLabel} Files ({targetFiles.length})
        </Text>
        <Button
          kind="tertiary"
          size="small"
          onClick={handleAddFileClick}
          disabled={isLoadingFiles || !knowledgeLayerAvailable || uploadDisabled}
          title={
            isLoadingFiles
              ? 'Loading files...'
              : knowledgeLayerAvailable
                ? 'Add files'
                : 'File upload not available'
          }
        >
          + Add File
        </Button>
      </Flex>

      {/* File list */}
      {targetFiles.map((file) => (
        <FileSourceCard
          key={file.id}
          id={file.id}
          title={file.fileName}
          fileSize={file.fileSize}
          uploadedAt={file.uploadedAt}
          status={mapToDisplayStatus(file.status)}
          errorMessage={file.errorMessage ?? undefined}
          expirationIntervalHours={fileUploadConfig.fileExpirationCheckIntervalHours}
          onDelete={handleDeleteClick}
        />
      ))}

      {/* Delete Confirmation Modal */}
      <DeleteFileConfirmationModal
        open={isDeleteModalOpen}
        onOpenChange={handleModalOpenChange}
        onConfirm={handleConfirmDelete}
      />
    </Flex>
  )
}
