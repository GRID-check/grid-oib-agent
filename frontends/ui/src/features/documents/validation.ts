/**
 * File Upload Validation
 *
 * Centralized validation logic for all file upload entry points.
 * Provides detailed error information rather than silent filtering.
 *
 * Validation Rules (configurable via AppConfig):
 * - Max file size per individual file (default: 100MB)
 * - Max total size (default: 100MB) and max file count (default: 10)
 * - Accepted types (default: .pdf, .docx, .txt, .md)
 *
 * The two cumulative caps are scoped by `ValidationContext.collectionKind`:
 * a chat session counts what is already attached, a durable collection measures
 * the incoming batch on its own. See {@link CollectionKind}.
 *
 * Behavior:
 * - File-level errors (duplicates, invalid types, oversized): Skip those files, upload others
 * - Batch-level errors (total size/count exceeded): Reject entire batch
 */

import type { FileUploadConfig } from '@/shared/context'
import type { TranslationVars } from '@/i18n'
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

/**
 * Which sentence a batch error renders.
 *
 * `'remaining'` names the headroom left beside files already in the store;
 * `'batch'` measures the batch on its own. A durable collection only ever
 * produces `'batch'` — nothing is carried over into its totals.
 */
export type BatchValidationVariant = 'batch' | 'remaining'

/** Batch-level error (affects the whole batch) */
export interface BatchValidationError {
  code: BatchValidationErrorCode
  /**
   * English fallback, and what {@link BatchValidationResult.summary} is built
   * from. A caller that HAS a translator renders `code` + `variant` + `values`
   * from the dictionary instead — `useFileUpload` does, so the German user who
   * hits a limit reads German. This module is pure and is called from specs and
   * non-React code, so it cannot hold a translator itself; it emits the facts
   * and the UI layer owns the sentence, exactly as `FileValidationReason` does
   * for the file-level VLM copy.
   */
  message: string
  variant: BatchValidationVariant
  /**
   * Interpolation values for the localized sentence. Sizes arrive already
   * formatted in the caller's locale (this module has no translator, but it
   * does have `formatBytes`); counts are plain numbers.
   */
  values: TranslationVars
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

/**
 * What KIND of file store the context's existing files belong to — and
 * therefore whether the cumulative caps mean anything.
 *
 * - `'chat-session'` — a conversation's attachment set: a throwaway working set
 *   assembled for one exchange, deliberately bounded. Its caps are CUMULATIVE
 *   over what is already attached, which is what "max files per session" has
 *   always meant.
 * - `'durable'` — a corpus that keeps growing for the life of the project or
 *   the organization: a project's Dateiablage, the org-wide Archiv. Its caps
 *   apply to the INCOMING BATCH only.
 *
 * This distinction is the fix for issue #432. Both surfaces run through
 * `useFileUpload`, so a project's persisted documents (loaded into the same
 * `trackedFiles` array by `UploadOrchestrator.loadFilesForSession`) were being
 * added to the session totals: "10 files per session" silently became "10
 * documents in this project, ever" — `Would have 11 files. Only 0 more allowed
 * (10 max).` — and the byte cap, a few files later, "100 MB per project, ever".
 *
 * Dropping the cumulative arithmetic on durable stores loses no resource
 * control, because it never was one: `/api/documents/upload` takes ONE file per
 * request, so a client-side batch total bounds nothing a determined caller
 * could not simply split. What actually bounds a durable corpus is the
 * organization's storage quota (ADR-0042), enforced server-side inside the
 * transaction that records the document — `assertWithinStorageQuota` /
 * `insertDocumentWithinQuota` in `@/lib/storage`.
 */
export type CollectionKind = 'chat-session' | 'durable'

/** Context for validation (files already in the target collection) */
export interface ValidationContext {
  /** What the target collection is, and so whether the caps accumulate. */
  collectionKind: CollectionKind
  /** Total size of files already in the collection (bytes) */
  existingTotalSize: number
  /** Number of files already in the collection */
  existingFileCount: number
  /** Names of files already in the collection (for duplicate detection) */
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
 * Create a default validation context (nothing in the collection yet).
 *
 * Defaults to `'chat-session'`: with no existing files the two kinds behave
 * identically, and a caller that has not said otherwise is the composer.
 */
export function createEmptyValidationContext(
  collectionKind: CollectionKind = 'chat-session'
): ValidationContext {
  return {
    collectionKind,
    existingTotalSize: 0,
    existingFileCount: 0,
    existingFileNames: new Set(),
  }
}

/**
 * The file-level half of {@link BatchValidationResult.summary}.
 *
 * Exported so a caller that re-renders the BATCH-level half from the dictionary
 * can rebuild the whole sentence rather than dropping the file-level part.
 */
export function summarizeFileErrors(fileErrors: FileValidationError[]): string | null {
  if (fileErrors.length === 0) return null
  return fileErrors.length === 1 ? fileErrors[0].message : `${fileErrors.length} files have issues`
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
 * 3. Duplicate file detection (against the batch AND the existing files)
 * 4. Total size (configurable, default 100MB)
 * 5. File count (configurable, default 10)
 *
 * Checks 4 and 5 include the files already in the collection only when
 * `context.collectionKind` is `'chat-session'`; a `'durable'` collection is
 * measured on the incoming batch alone (issue #432, see {@link CollectionKind}).
 *
 * File-level errors (duplicates, invalid types, oversized) will skip those files
 * but allow other valid files to proceed. Batch-level errors (total size/count
 * exceeded) will reject the entire batch.
 *
 * @param files - Array of files to validate
 * @param context - Optional context with the target collection's kind and existing files
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

  // Only a chat session carries its existing files into the totals. A durable
  // collection is measured on the incoming batch alone — see {@link CollectionKind}
  // and issue #432. Duplicate detection above is untouched by this: it is about
  // identity, not volume, and is still correct (and useful) on a durable store.
  const accumulates = context.collectionKind === 'chat-session'
  const carriedSize = accumulates ? context.existingTotalSize : 0
  const carriedCount = accumulates ? context.existingFileCount : 0

  const totalSize = carriedSize + newFilesTotalSize
  const totalCount = carriedCount + potentiallyValidFiles.length

  // A batch carrying a model gets the IFC ceiling as its total, or one legal
  // 150 MB model would clear the per-file check and then fail a 100 MB BATCH
  // limit it could never satisfy. Lifted per-batch rather than in the config so
  // a batch of ordinary documents keeps the document limit.
  //
  // In a chat session the EXISTING files count too, not just the new ones.
  // `totalSize` includes `existingTotalSize` there, so once a 149 MB model is in
  // the session the total is over the document limit forever: the next add —
  // even a 20 kB text file, even a re-drop of the model itself, which pass 1
  // drops as a duplicate and so keeps out of `potentiallyValidFiles` — was
  // measured against 100 MB and told the user "Only 0 B available". On a durable
  // collection those bytes are not in `totalSize` at all, so a model sitting in
  // the Dateiablage must NOT lift the ceiling for an unrelated batch of PDFs.
  const carriesIfc =
    potentiallyValidFiles.some((file) => isIfcFilename(file.name)) ||
    (accumulates && [...context.existingFileNames].some((name) => isIfcFilename(name)))
  const totalCeiling =
    carriesIfc && config.maxIfcFileSize > config.maxTotalSize
      ? config.maxIfcFileSize
      : config.maxTotalSize

  // Check total size constraint
  if (totalSize > totalCeiling) {
    const total = formatBytes(totalSize, locale)
    const limit = formatBytes(totalCeiling, locale)
    if (carriedSize > 0) {
      const available = formatBytes(Math.max(0, totalCeiling - carriedSize), locale)
      batchErrors.push({
        code: 'TOTAL_SIZE_EXCEEDED',
        variant: 'remaining',
        message: `Total size would be ${total}. Only ${available} available (${limit} limit).`,
        values: { total, available, limit },
      })
    } else {
      batchErrors.push({
        code: 'TOTAL_SIZE_EXCEEDED',
        variant: 'batch',
        message: `Total size ${total} exceeds ${limit} limit.`,
        values: { total, limit },
      })
    }
  }

  // Check file count constraint
  if (totalCount > config.maxFileCount) {
    if (carriedCount > 0) {
      const available = Math.max(0, config.maxFileCount - carriedCount)
      batchErrors.push({
        code: 'MAX_FILES_EXCEEDED',
        variant: 'remaining',
        message: `Would have ${totalCount} files. Only ${available} more allowed (${config.maxFileCount} max).`,
        values: { total: totalCount, available, limit: config.maxFileCount },
      })
    } else {
      batchErrors.push({
        code: 'MAX_FILES_EXCEEDED',
        variant: 'batch',
        message: `${totalCount} files exceeds the ${config.maxFileCount} file limit.`,
        values: { total: totalCount, limit: config.maxFileCount },
      })
    }
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

    const fileErrorSummary = summarizeFileErrors(fileErrors)
    if (fileErrorSummary) parts.push(fileErrorSummary)

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
