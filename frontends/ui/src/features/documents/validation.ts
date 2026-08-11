/**
 * File Upload Validation
 *
 * Centralized validation logic for all file upload entry points.
 * Provides detailed error information rather than silent filtering.
 *
 * Validation Rules (configurable via AppConfig):
 * - Max file size per individual file (default: 100MB)
 * - Max total size including existing session files (default: 100MB)
 * - Max files total including existing session files (default: 10)
 * - Accepted types (default: .pdf, .docx, .txt, .md)
 *
 * Behavior:
 * - File-level errors (duplicates, invalid types, oversized): Skip those files, upload others
 * - Batch-level errors (total size/count exceeded): Reject entire batch
 */

import type { FileUploadConfig } from '@/shared/context'
import { IMAGE_EXTENSIONS } from '@/shared/config/file-upload'
import { isIfcFilename } from '@/lib/bim/types'
// The same formatter every file size in the UI renders through. These messages
// name a size the user can also see on a file card, so a second implementation
// meant one screen showing "1,5 MB" beside "1.5 MB" in German.
import {
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_TOTAL_SIZE,
  DEFAULT_MAX_FILE_COUNT,
  DEFAULT_ACCEPTED_FILE_TYPES,
  DEFAULT_ACCEPTED_MIME_TYPES,
} from './constants'
import { formatBytes } from '@/lib/format'

// ============================================================================
// Types
// ============================================================================

/** Error codes for file validation failures */
export type FileValidationErrorCode = 'FILE_TOO_LARGE' | 'INVALID_TYPE' | 'DUPLICATE_FILE'

/** Error codes for batch-level validation failures */
export type BatchValidationErrorCode = 'TOTAL_SIZE_EXCEEDED' | 'MAX_FILES_EXCEEDED'

/**
 * Machine-readable sub-reason for an INVALID_TYPE rejection, so the UI can show
 * a targeted message. `'image-vlm-unavailable'` = the file is an image and
 * images are off specifically because no vision model is configured (the
 * `image-upload` flag is on but the capability is missing).
 */
export type FileValidationReason = 'image-vlm-unavailable'

/** Detailed error information for a single file */
export interface FileValidationError {
  file: File
  code: FileValidationErrorCode
  message: string
  /** Optional targeted reason enabling localized, specific copy in the UI. */
  reason?: FileValidationReason
}

/** Batch-level error (affects the whole batch) */
export interface BatchValidationError {
  code: BatchValidationErrorCode
  message: string
}

/** Result of validating a batch of files */
export interface BatchValidationResult {
  /** Whether all files passed validation and batch constraints are met */
  valid: boolean
  /** Whether there is at least one uploadable file and no batch-level blockers */
  canUpload: boolean
  /** Files that would be valid (empty if batch is invalid) */
  validFiles: File[]
  /** Individual file errors */
  fileErrors: FileValidationError[]
  /** Batch-level errors (size/count limits) */
  batchErrors: BatchValidationError[]
  /** Human-readable summary for UI display */
  summary: string | null
}

/** Context for validation (existing files in session) */
export interface ValidationContext {
  /** Total size of files already in the session (bytes) */
  existingTotalSize: number
  /** Number of files already in the session */
  existingFileCount: number
  /** Names of files already in the session (for duplicate detection) */
  existingFileNames: Set<string>
}

/** Default file upload configuration (used when AppConfig is not available) */
const DEFAULT_CONFIG: FileUploadConfig = {
  acceptedTypes: DEFAULT_ACCEPTED_FILE_TYPES,
  acceptedMimeTypes: DEFAULT_ACCEPTED_MIME_TYPES,
  maxTotalSizeMB: 100,
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
  // 0 = no IFC allowance. This fallback is for when AppConfig is absent, and a
  // config that cannot say whether IFC is enabled must not invent a ceiling.
  maxIfcFileSize: 0,
  maxTotalSize: DEFAULT_MAX_TOTAL_SIZE,
  maxFileCount: DEFAULT_MAX_FILE_COUNT,
  fileExpirationCheckIntervalHours: 0,
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Whether a filename carries a gated image extension (.png/.jpg/.jpeg). */
function isImageFileName(fileName: string): boolean {
  const idx = fileName.lastIndexOf('.')
  if (idx <= 0) return false
  const ext = fileName.slice(idx).toLowerCase()
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Check if a file has a valid extension
 * @param fileName - Name of the file to check
 * @param config - Optional file upload configuration (uses defaults if not provided)
 */
export function isValidFileExtension(
  fileName: string,
  config: FileUploadConfig = DEFAULT_CONFIG
): boolean {
  const parts = fileName.split('.')
  if (parts.length < 2) return false
  const acceptedExtensions = config.acceptedTypes.split(',').map((ext) => ext.toLowerCase().trim())
  const extension = '.' + parts.pop()?.toLowerCase()
  return acceptedExtensions.includes(extension)
}

/**
 * Check if a MIME type is valid (used during drag operations)
 * @param mimeType - MIME type to check
 * @param config - Optional file upload configuration (uses defaults if not provided)
 */
export function isValidMimeType(
  mimeType: string,
  config: FileUploadConfig = DEFAULT_CONFIG
): boolean {
  // Empty MIME type is allowed (some files like .md may not have one)
  if (!mimeType) return true
  const normalized = mimeType.toLowerCase()
  return config.acceptedMimeTypes.some((m) => m.toLowerCase() === normalized)
}

/**
 * Create default validation context (empty session)
 */
export function createEmptyValidationContext(): ValidationContext {
  return {
    existingTotalSize: 0,
    existingFileCount: 0,
    existingFileNames: new Set(),
  }
}

// ============================================================================
// Main Validation Function
// ============================================================================

/**
 * Validate a batch of files for upload.
 *
 * Performs the following checks:
 * 1. Individual file type validation (extension-based)
 * 2. Individual file size (configurable, default 100MB)
 * 3. Duplicate file detection
 * 4. Total size including existing files (configurable, default 100MB)
 * 5. File count including existing files (configurable, default 10)
 *
 * File-level errors (duplicates, invalid types, oversized) will skip those files
 * but allow other valid files to proceed. Batch-level errors (total size/count
 * exceeded) will reject the entire batch.
 *
 * @param files - Array of files to validate
 * @param context - Optional context with existing session files info
 * @param config - Optional file upload configuration (uses defaults if not provided)
 * @returns Detailed validation result
 */
export function validateFileUpload(
  files: File[],
  context: ValidationContext = createEmptyValidationContext(),
  config: FileUploadConfig = DEFAULT_CONFIG,
  /**
   * The APP's active locale, so a size in an error message is punctuated the
   * same as the one on the file card beside it. Optional because the specs and
   * any non-React caller have no locale to give; omitting it falls back to the
   * runtime default, which is right for them and wrong for a user whose app
   * language differs from their browser's.
   */
  locale?: string
): BatchValidationResult {
  const fileErrors: FileValidationError[] = []
  const batchErrors: BatchValidationError[] = []
  const potentiallyValidFiles: File[] = []

  // Track new files for batch calculations
  let newFilesTotalSize = 0
  const newFileNames = new Set<string>()

  // -------------------------------------------------------------------------
  // Pass 1: Validate individual files
  // -------------------------------------------------------------------------

  for (const file of files) {
    // Check for duplicates within the new batch
    if (newFileNames.has(file.name)) {
      fileErrors.push({
        file,
        code: 'DUPLICATE_FILE',
        message: `"${file.name}" is included multiple times`,
      })
      continue
    }

    // Check for duplicates against existing session files
    if (context.existingFileNames.has(file.name)) {
      fileErrors.push({
        file,
        code: 'DUPLICATE_FILE',
        message: `"${file.name}" already exists in this session`,
      })
      continue
    }

    // Check file type (extension)
    if (!isValidFileExtension(file.name, config)) {
      // When an image is rejected specifically because no VLM is configured
      // (flag on, capability off), tag it so the UI can explain WHY instead of
      // a generic "unsupported type" — the base message stays as a fallback.
      const isImageBlockedByVlm =
        config.imageUploadBlockedReason === 'vlm-unavailable' && isImageFileName(file.name)
      fileErrors.push({
        file,
        code: 'INVALID_TYPE',
        message: isImageBlockedByVlm
          ? `"${file.name}" needs a configured vision model (VLM) to upload.`
          : `"${file.name}" is not a supported file type. Accepted: ${config.acceptedTypes}`,
        ...(isImageBlockedByVlm ? { reason: 'image-vlm-unavailable' as const } : {}),
      })
      continue
    }

    // Check individual file size. A `.ifc` is measured against the IFC ceiling,
    // not the document one — a building model is an order of magnitude larger
    // than the PDFs `maxFileSize` was sized for, and refusing one for being a
    // big FILE told the user nothing about what to do.
    const sizeCeiling =
      isIfcFilename(file.name) && config.maxIfcFileSize > 0
        ? config.maxIfcFileSize
        : config.maxFileSize
    if (file.size > sizeCeiling) {
      fileErrors.push({
        file,
        code: 'FILE_TOO_LARGE',
        message: `"${file.name}" is ${formatBytes(file.size, locale)}, exceeds ${formatBytes(sizeCeiling, locale)} limit`,
      })
      continue
    }

    // File passed individual validation
    potentiallyValidFiles.push(file)
    newFilesTotalSize += file.size
    newFileNames.add(file.name)
  }

  // -------------------------------------------------------------------------
  // Pass 2: Validate batch constraints (including existing files)
  // -------------------------------------------------------------------------

  const totalSize = context.existingTotalSize + newFilesTotalSize
  const totalCount = context.existingFileCount + potentiallyValidFiles.length

  // A batch carrying a model gets the IFC ceiling as its total, or one legal
  // 150 MB model would clear the per-file check and then fail a 100 MB BATCH
  // limit it could never satisfy. Lifted per-batch rather than in the config so
  // a batch of ordinary documents keeps the document limit.
  //
  // The session's EXISTING files count too, not just the new ones. `totalSize`
  // includes `existingTotalSize`, so once a 149 MB model is in the session the
  // total is over the document limit forever: the next add — even a 20 kB
  // text file, even a re-drop of the model itself, which pass 1 drops as a
  // duplicate and so keeps out of `potentiallyValidFiles` — was measured
  // against 100 MB and told the user "Only 0 B available".
  const carriesIfc =
    potentiallyValidFiles.some((file) => isIfcFilename(file.name)) ||
    [...context.existingFileNames].some((name) => isIfcFilename(name))
  const totalCeiling =
    carriesIfc && config.maxIfcFileSize > config.maxTotalSize
      ? config.maxIfcFileSize
      : config.maxTotalSize

  // Check total size constraint
  if (totalSize > totalCeiling) {
    const availableSpace = Math.max(0, totalCeiling - context.existingTotalSize)
    batchErrors.push({
      code: 'TOTAL_SIZE_EXCEEDED',
      message:
        context.existingTotalSize > 0
          ? `Total size would be ${formatBytes(totalSize, locale)}. Only ${formatBytes(availableSpace, locale)} available (${formatBytes(totalCeiling, locale)} limit).`
          : `Total size ${formatBytes(totalSize, locale)} exceeds ${formatBytes(totalCeiling, locale)} limit.`,
    })
  }

  // Check file count constraint
  if (totalCount > config.maxFileCount) {
    const availableSlots = Math.max(0, config.maxFileCount - context.existingFileCount)
    batchErrors.push({
      code: 'MAX_FILES_EXCEEDED',
      message:
        context.existingFileCount > 0
          ? `Would have ${totalCount} files. Only ${availableSlots} more allowed (${config.maxFileCount} max).`
          : `${totalCount} files exceeds the ${config.maxFileCount} file limit.`,
    })
  }

  // -------------------------------------------------------------------------
  // Build result
  // -------------------------------------------------------------------------

  // Batch errors block the entire upload; file errors just skip those files
  const hasBatchErrors = batchErrors.length > 0
  const hasFileErrors = fileErrors.length > 0
  const isValid = !hasBatchErrors && !hasFileErrors && potentiallyValidFiles.length > 0
  const canUpload = !hasBatchErrors && potentiallyValidFiles.length > 0

  // Generate human-readable summary
  let summary: string | null = null
  if (hasFileErrors || hasBatchErrors) {
    const parts: string[] = []

    if (hasFileErrors) {
      const fileErrorSummary =
        fileErrors.length === 1 ? fileErrors[0].message : `${fileErrors.length} files have issues`
      parts.push(fileErrorSummary)
    }

    if (hasBatchErrors) {
      parts.push(...batchErrors.map((e) => e.message))
    }

    summary = parts.join(' ')
  }

  return {
    valid: isValid,
    canUpload,
    // Return valid files unless there are batch-level errors
    // File-level errors just skip those files, allowing partial uploads
    validFiles: hasBatchErrors ? [] : potentiallyValidFiles,
    fileErrors,
    batchErrors,
    summary,
  }
}

// ============================================================================
// Drag-Drop Helper
// ============================================================================

/**
 * Quick check if dragged files are potentially supported (for drag state feedback).
 * Only checks MIME types - not full validation.
 * Used to show "unsupported file type" indicator during drag.
 *
 * @param dataTransfer - DataTransfer object from drag event
 * @param config - Optional file upload configuration (uses defaults if not provided)
 */
export function checkDraggedFilesSupported(
  dataTransfer: DataTransfer,
  config: FileUploadConfig = DEFAULT_CONFIG
): boolean {
  const items = Array.from(dataTransfer.items)
  for (const item of items) {
    if (item.kind === 'file') {
      if (!isValidMimeType(item.type, config)) {
        return false
      }
    }
  }
  return true
}
