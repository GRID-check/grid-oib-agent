/**
 * FileUploadZone Component
 *
 * Drag-and-drop file upload zone built on a hidden native file input
 * plus a styled drop target. Integrates with useFileUpload hook for
 * handling uploads.
 */

'use client'

import { type ChangeEvent, type FC, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { FileText, Upload } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import { useDocumentsStore } from '../store'
import { useIsCurrentSessionBusy } from '@/features/chat'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import type { TrackedFile } from '../types'
import { uploadPhase, type UploadPhase } from '../lib/upload-progress'
import { HeldUploadReason } from './held-upload-reason'
import { ingestionMarkOfPhase, IngestionStatusWord } from './ingestion-atoms'
import { quarantineVerdictOf, type QuarantineVerdict } from '@/lib/upload-screening/quarantine'
import { photoIntake, prepareSitePhotos } from '../lib/site-photo'
import { ACCEPTED_FILE_TYPES, MAX_FILE_SIZE } from '../'
import type { Transition } from 'motion/react'
import {
  AnimatePresence,
  motion,
  motionQuick,
  springDrawer,
  springPress,
  useMotionToken,
} from '@/components/motion'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

/**
 * What a row shows: the upload tray's phase of the same file (`uploadPhase`),
 * drawn with the same glyph (`ingestionMarkOfPhase`), so the zone and the tray
 * cannot name one file's state two ways. `held` (the content check, ADR-0086)
 * and `stored` (kept, not read) are at rest and neither green nor red;
 * `canceled` is the user's own decision.
 */
interface UploadedFile {
  id: string
  file: File
  phase: UploadPhase
  errorMessage?: string
  replacesHeld?: TrackedFile['replacesHeld']
  /** Why a held file is held (`quarantineVerdictOf`), read once where the row is mirrored. */
  verdict: QuarantineVerdict | null
}

/** In flight: the zone's one moving mark, since it has no header to carry the loop. */
const IN_FLIGHT: ReadonlySet<UploadPhase> = new Set<UploadPhase>(['queued', 'uploading', 'processing'])

interface FileUploadZoneProps {
  /** Collection name for filtering displayed files */
  collectionName?: string
  /** @deprecated use collectionName */
  sessionId?: string
  /** Max file size in bytes (for display only) */
  maxFileSize?: number
  /** Accepted file types (MIME types or extensions) */
  acceptedTypes?: string
  /** Handler for uploading files (parent handles validation via hook) */
  onUpload?: (files: File[]) => void
  /** Whether upload is in progress */
  isUploading?: boolean
  /** Label for the form field */
  label?: string
}

/**
 * A queued file's row: the rise lands on `springDrawer`, the fade is the
 * `motionQuick` tween (opacity never springs). Instant under reduced motion.
 */
const rowTransition: Transition = { ...springDrawer, opacity: motionQuick }

// ============================================================================
// Component
// ============================================================================

export const FileUploadZone: FC<FileUploadZoneProps> = ({
  collectionName,
  sessionId,
  maxFileSize = MAX_FILE_SIZE,
  acceptedTypes = ACCEPTED_FILE_TYPES,
  onUpload,
  isUploading = false,
  label,
}) => {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const row = useMotionToken(rowTransition)
  // Check if current session is busy with operations
  const isBusy = useIsCurrentSessionBusy()
  const targetCollectionName = collectionName ?? sessionId
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()

  // Get files for current upload target collection
  const trackedFiles = useDocumentsStore((state) => state.trackedFiles)
  const collectionFiles = useMemo(
    () => (targetCollectionName ? trackedFiles.filter((f) => f.collectionName === targetCollectionName) : []),
    [trackedFiles, targetCollectionName]
  )

  // Mirror tracked files into the upload value shape used for rendering file cards
  const [uploadValue, setUploadValue] = useState<UploadedFile[]>([])

  // Sync collection files to uploadValue
  useEffect(() => {
    const mapped = collectionFiles
      .filter((tf) => tf.file) // Only include files with File object (can be displayed)
      .map((tf) => ({
        id: tf.id,
        file: tf.file!,
        phase: uploadPhase(tf),
        errorMessage: tf.errorMessage ?? undefined,
        replacesHeld: tf.replacesHeld,
        verdict: tf.status === 'held' ? quarantineVerdictOf(tf) : null,
      }))
    setUploadValue(mapped)
  }, [collectionFiles])

  const uploadDisabled = isUploading || isBusy

  const tCapture = useTranslations('capture')
  const handleValueChange = useCallback(
    (selected: File[]) => {
      if (selected.length === 0) return
      // A photo gets a name of its own before validation sees it: the name is
      // the document's identity, and iOS calls a library or camera photo
      // `image.jpg` (`site-photo.ts`). Validation happens in uploadFiles.
      void prepareSitePhotos(selected, {
        source: 'picker',
        prefix: tCapture('photos.fileNamePrefix'),
        taken: collectionFiles.map((file) => file.fileName),
        imagesAccepted: photoIntake({ acceptedTypes }).available,
      }).then(({ files, unconvertibleHeic }) => {
        // An unconvertible HEIC goes on under its own name, for the hook's
        // validation to report alongside every other refused file.
        const rest = selected.filter((file) => unconvertibleHeic.includes(file.name))
        if (files.length + rest.length > 0) onUpload?.([...files, ...rest])
      })
    },
    [onUpload, tCapture, collectionFiles, acceptedTypes]
  )

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? [])
      handleValueChange(files)
      // Reset so selecting the same file again re-triggers onChange
      event.target.value = ''
    },
    [handleValueChange]
  )

  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: handleValueChange,
    disabled: uploadDisabled,
  })

  const openFilePicker = useCallback(() => {
    if (!uploadDisabled) inputRef.current?.click()
  }, [uploadDisabled])

  return (
    <div className="flex flex-col gap-3">
      {label ? <Label htmlFor={inputId}>{label}</Label> : null}

      <motion.div
        {...dragHandlers}
        animate={{ scale: isDragging ? 1.01 : 1 }}
        transition={springPress}
        role="button"
        tabIndex={uploadDisabled ? -1 : 0}
        aria-disabled={uploadDisabled}
        onClick={openFilePicker}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !uploadDisabled) {
            event.preventDefault()
            openFilePicker()
          }
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          isDragging && isUnsupportedDrag && 'border-destructive bg-destructive/5',
          isDragging && !isUnsupportedDrag && 'border-ring bg-primary/5',
          !isDragging && 'border-border bg-muted hover:border-ring hover:bg-primary/5',
          uploadDisabled && 'pointer-events-none cursor-not-allowed opacity-50'
        )}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={acceptedTypes}
          disabled={uploadDisabled}
          onChange={handleInputChange}
          data-testid="nv-upload-input-element"
          className="hidden"
        />
        <Upload className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-primary">{t('uploadZone.clickToUpload')}</span>{t('uploadZone.orDragAndDrop')}
        </p>
        <p className="text-xs text-muted-foreground">
          <span>{t('uploadZone.maxSize', { size: formatBytes(maxFileSize, locale) })}</span>
          <span> · </span>
          <span>{t('uploadZone.accepts', { types: acceptedTypes })}</span>
        </p>
      </motion.div>

      {uploadValue.length > 0 && (
        <ul className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
          {uploadValue.map((item) => (
            <motion.li
              key={item.id}
              role="listitem"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={row}
              className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2 shadow-xs"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{item.file.name}</p>
                {/* A held file's stored text is the verdict as JSON: it reads
                    as its reasons, never as a red error line. */}
                {item.phase === 'held' ? (
                  <HeldUploadReason
                    verdict={item.verdict}
                    replacesHeld={item.replacesHeld}
                    message={item.errorMessage}
                    testId="upload-zone-held"
                  />
                ) : item.phase === 'failed' && item.errorMessage ? (
                  <p className="text-xs text-destructive">{item.errorMessage}</p>
                ) : null}
              </div>
              {IN_FLIGHT.has(item.phase) ? (
                <Spinner size="sm" className="shrink-0 text-muted-foreground" />
              ) : (
                // The tray's glyph and ink for the same phase; the word is for
                // assistive tech, the row has no room for it.
                <IngestionStatusWord mark={ingestionMarkOfPhase(item.phase)} className="shrink-0">
                  <span className="sr-only" data-testid="upload-zone-state">
                    {t(`uploads.row.${item.phase}`)}
                  </span>
                </IngestionStatusWord>
              )}
            </motion.li>
          ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  )
}
