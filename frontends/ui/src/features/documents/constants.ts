/**
 * Documents Feature Constants
 *
 * Default values for file upload limits and accepted types.
 * These are used as fallbacks when AppConfig is not available.
 * Runtime configuration is provided via AppConfigContext from environment variables.
 */

/**
 * Default maximum file size in bytes per individual file (100 MB).
 *
 * Decimal MB, matching `BYTES_PER_MB` in the config these values are the
 * fallback for — the client-side fallback and the server-composed limit must
 * agree, or a file passes one validator and is refused by the other with a
 * different number in the message.
 */
export const DEFAULT_MAX_FILE_SIZE = 100 * 1e6

/** Default maximum total size for all files including existing session files (100 MB). */
export const DEFAULT_MAX_TOTAL_SIZE = 100 * 1e6

/** Default maximum number of files per session */
export const DEFAULT_MAX_FILE_COUNT = 10

/**
 * Default accepted file extensions for upload (used by file inputs).
 *
 * Images (.png/.jpg/.jpeg) are intentionally excluded here: they are a derived
 * capability, offered only when the `image-upload` flag allows AND a VLM is
 * configured (availability = flag AND capability). This constant is only the
 * fallback used when no AppConfig is available; the real accepted-types list is
 * composed server-side in getFileUploadConfigFromEnv.
 */
export const DEFAULT_ACCEPTED_FILE_TYPES = '.pdf,.docx,.txt,.md,.csv,.xlsx,.pptx'

/** Default accepted MIME types for upload (used for drag-drop validation) */
export const DEFAULT_ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
]

// Legacy exports for backward compatibility (use AppConfig where possible)
/** @deprecated Use AppConfig.fileUpload.maxFileSize instead */
export const MAX_FILE_SIZE = DEFAULT_MAX_FILE_SIZE
/** @deprecated Use AppConfig.fileUpload.maxTotalSize instead */
export const MAX_TOTAL_SIZE = DEFAULT_MAX_TOTAL_SIZE
/** @deprecated Use AppConfig.fileUpload.maxFileCount instead */
export const MAX_FILE_COUNT = DEFAULT_MAX_FILE_COUNT
/** @deprecated Use AppConfig.fileUpload.acceptedTypes instead */
export const ACCEPTED_FILE_TYPES = DEFAULT_ACCEPTED_FILE_TYPES
/** @deprecated Use AppConfig.fileUpload.acceptedMimeTypes instead */
export const ACCEPTED_MIME_TYPES = new Set(DEFAULT_ACCEPTED_MIME_TYPES)
