/**
 * FileSourcesTab Component
 *
 * Content for the "File Sources" tab in the DataSourcePanel.
 * Displays a list of uploaded file sources with their status.
 * Integrates with file upload system for real-time progress tracking.
 */

'use client'

import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { UploadCloud, X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatePresence } from '@/components/motion'
import { FileSourceCard, FileSourceCardSkeleton } from './FileSourceCard'
import { DeleteFileConfirmationModal } from './DeleteFileConfirmationModal'
import { useUploadDestination } from './UploadDestination'
import { FilePreviewDialog } from '@/features/documents/components/file-preview-dialog'
import {
  useFileUpload,
  useDocumentsStore,
  FileUploadZone,
  mapToDisplayStatus,
} from '@/features/documents'
import { trackedFileToFileItem } from '@/features/documents/types'
import type { TrackedFile } from '@/features/documents'
import { sessionHasKnownCollection } from '@/features/documents/persistence'
import { useChatStore } from '@/features/chat/store'
import { useLayoutStore } from '../store'
import { useAppConfig } from '@/shared/context'
import { useTranslations } from '@/i18n'

interface FileSourcesTabProps {
  /** Callback when a file is deleted */
  onDeleteFile?: (id: string) => void
}

/** Dismissable inline error alert used for upload failures. */
const UploadErrorAlert: FC<{ message: string; onClose: () => void; className?: string }> = ({
  message,
  onClose,
  className,
}) => {
  const t = useTranslations('research')
  return (
  <Alert variant="destructive" className={className}>
    <AlertDescription className="flex w-full items-start justify-between gap-2">
      <span>{message}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('dismissError')}
        className="shrink-0 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </AlertDescription>
  </Alert>
  )
}

/**
 * Tab content showing list of uploaded file sources.
 * Connected to the file upload store for real-time updates.
 */
export const FileSourcesTab: FC<FileSourcesTabProps> = ({ onDeleteFile }) => {
  const t = useTranslations('research')
  // Get current conversation and ensureSession for session management
  const currentConversation = useChatStore((state) => state.currentConversation)
  const ensureSession = useChatStore((state) => state.ensureSession)
  const projectId = useChatStore((state) => state.projectId)
  const [uploadTarget, setUploadTarget] = useState<'project' | 'session'>(
    projectId ? 'project' : 'session'
  )
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

  // The destination, in the shared vocabulary the composer now states too.
  const destination = useUploadDestination(isProjectTarget ? 'project' : 'session')
  const uploadTargetLabel = destination.label
  const uploadDisabled = isUploading || (isProjectTarget && !projectCollectionName)

  // Delete confirmation modal state
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [fileIdToDelete, setFileIdToDelete] = useState<string | null>(null)

  // Read-only preview opened by tapping an available file row.
  const [previewFile, setPreviewFile] = useState<TrackedFile | null>(null)
  const handleOpenPreview = useCallback(
    (fileId: string) => {
      const file = targetFiles.find((f) => f.id === fileId)
      if (file) setPreviewFile(file)
    },
    [targetFiles]
  )

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
      let sessionId: string | undefined
      if (!isProjectTarget) {
        sessionId = ensureSession()
        if (!sessionId) {
          console.error('Failed to create session for upload')
          return
        }
      }
      // Pass the (possibly just-created) session explicitly: the hook's
      // memoized collectionName still reflects the previous render, so the
      // first upload in a fresh session would otherwise abort.
      await uploadFiles(files, sessionId)
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
    <div className="flex flex-col gap-2 rounded-xl bg-muted p-3">
      <span className="text-xs font-semibold uppercase text-muted-foreground">{t('fileSourcesTab.uploadTo')}</span>
      <div className="flex gap-2">
        <Button
          variant={uploadTarget === 'project' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setUploadTarget('project')}
          disabled={!projectCollectionName}
        >
          {t('fileSourcesTab.targetProject')}
        </Button>
        <Button
          variant={uploadTarget === 'session' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setUploadTarget('session')}
        >
          {t('fileSourcesTab.targetSession')}
        </Button>
      </div>
      <span className="text-xs text-muted-foreground">
        {isProjectTarget
          ? projectCollectionName
            ? t('fileSourcesTab.availableInProject')
            : t('fileSourcesTab.preparingCorpus')
          : t('fileSourcesTab.onlyThisSession')}
      </span>
    </div>
  ) : null

  if (targetFiles.length === 0) {
    // When files are expected (loading, uploading, or session known to have files),
    // always show the spinner — never flash "No Files" during transitions.
    if (isAwaitingFiles) {
      // Skeleton rows that mirror the real FileSourceCard shape — matching the
      // grid file surfaces' skeleton vocabulary instead of a lone centered
      // spinner. The status text stays for screen readers / assertions.
      return (
        <div className="flex flex-1 flex-col gap-2" aria-busy="true">
          <span className="sr-only">{t('fileSourcesTab.checkingFiles')}</span>
          {Array.from({ length: 3 }).map((_, i) => (
            <FileSourceCardSkeleton key={i} />
          ))}
        </div>
      )
    }

    return (
      <div className="flex flex-1 flex-col gap-4">
        {/* Show info banner when file upload is not available */}
        {uploadTargetControls}

        {!knowledgeLayerAvailable && (
          <Alert variant="info" className="mb-6">
            <AlertDescription>{t('fileSourcesTab.setupBackend')}</AlertDescription>
          </Alert>
        )}

        {/* Crafted empty state when upload is available — the chat file surface
            is often the first place a user attaches a document, so it deserves
            the same designed empty state as the rest of the app, not bare text. */}
        {knowledgeLayerAvailable && (
          <EmptyState
            variant="bare"
            icon={UploadCloud}
            title={t('fileSourcesTab.noAttachedFiles')}
            description={destination.sentence}
          />
        )}

        {/* Upload Error Display */}
        {uploadError && <UploadErrorAlert message={uploadError} onClose={clearError} />}

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
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto">
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
      {uploadError && <UploadErrorAlert message={uploadError} onClose={clearError} />}

      {/* Header with count and add button */}
      {uploadTargetControls}

      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {t('fileSourcesTab.filesCount', { target: uploadTargetLabel, count: targetFiles.length })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleAddFileClick}
          disabled={isLoadingFiles || !knowledgeLayerAvailable || uploadDisabled}
          title={
            isLoadingFiles
              ? t('fileSourcesTab.loadingFilesEllipsis')
              : knowledgeLayerAvailable
                ? t('fileSourcesTab.addFiles')
                : t('fileSourcesTab.uploadNotAvailable')
          }
        >
          {t('fileSourcesTab.addFile')}
        </Button>
      </div>

      {/* File list — AnimatePresence lets deleted cards fade out; initial={false}
          keeps hydrated lists static while newly uploaded files animate in */}
      <AnimatePresence initial={false}>
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
            onOpen={handleOpenPreview}
          />
        ))}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <DeleteFileConfirmationModal
        open={isDeleteModalOpen}
        onOpenChange={handleModalOpenChange}
        onConfirm={handleConfirmDelete}
        fileName={targetFiles.find((f) => f.id === fileIdToDelete)?.fileName}
      />

      {/* Read-only preview opened by tapping an available file row. */}
      <FilePreviewDialog
        file={previewFile ? trackedFileToFileItem(previewFile) : null}
        canManage={false}
        onClose={() => setPreviewFile(null)}
      />
    </div>
  )
}
