import type { FileUploadConfig } from '@/shared/context'

// Image types are intentionally NOT shipped as defaults: image ingestion has a
// hard runtime dependency on a configured VLM, and the `image-upload` flag fails
// open — so a VLM-less deployment that shipped images by default would accept
// uploads guaranteed to fail ingestion. Images become available only when a
// deployment opts in via FILE_UPLOAD_ACCEPTED_TYPES (alongside AIQ_VLM_*) AND the
// image-upload flag allows. The EXTENSION_TO_MIME image entries below stay so
// that env-driven enablement still resolves their MIME types.
const DEFAULT_ACCEPTED_TYPES = '.pdf,.docx,.txt,.md'
const DEFAULT_MAX_SIZE_MB = 100
const DEFAULT_MAX_FILE_COUNT = 10
const DEFAULT_EXPIRATION_CHECK_INTERVAL_HOURS = 0

const EXTENSION_TO_MIME: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.md': ['text/markdown', 'text/x-markdown'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.html': ['text/html'],
  '.txt': ['text/plain'],
  '.csv': ['text/csv'],
  '.json': ['application/json'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
}

/**
 * Image extensions gated behind the WorkOS `image-upload` flag (FB-15a). When
 * the flag is off they are stripped from the accepted-types list before it
 * reaches the client, so the file picker + drag-drop never offer them.
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const

const stripImageExtensions = (acceptedTypes: string): string =>
  acceptedTypes
    .split(',')
    .map((ext) => ext.trim())
    .filter((ext) => ext && !IMAGE_EXTENSIONS.includes(ext.toLowerCase() as (typeof IMAGE_EXTENSIONS)[number]))
    .join(',')

const parsePositiveNumber = (value: string | undefined): number | null => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  if (parsed <= 0) return null
  return parsed
}

export const buildAcceptedMimeTypes = (acceptedTypes: string): string[] => {
  const mimeTypes = new Set<string>()
  const extensions = acceptedTypes
    .split(',')
    .map((ext) => ext.toLowerCase().trim())
    .filter(Boolean)

  for (const ext of extensions) {
    const mimes = EXTENSION_TO_MIME[ext]
    if (!mimes) continue
    for (const mime of mimes) {
      mimeTypes.add(mime.toLowerCase())
    }
  }

  return Array.from(mimeTypes)
}

export const getFileUploadConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  options: { imageUploadEnabled?: boolean } = {}
): FileUploadConfig => {
  const { imageUploadEnabled = true } = options
  const rawAcceptedTypes = env.FILE_UPLOAD_ACCEPTED_TYPES || DEFAULT_ACCEPTED_TYPES
  // Image types only reach the client when the `image-upload` flag allows it.
  const acceptedTypes = imageUploadEnabled ? rawAcceptedTypes : stripImageExtensions(rawAcceptedTypes)
  const maxTotalSizeMB = parsePositiveNumber(env.FILE_UPLOAD_MAX_SIZE_MB) ?? DEFAULT_MAX_SIZE_MB
  const maxFileCount =
    parsePositiveNumber(env.FILE_UPLOAD_MAX_FILE_COUNT) ?? DEFAULT_MAX_FILE_COUNT
  const fileExpirationCheckIntervalHours =
    parsePositiveNumber(env.FILE_EXPIRATION_CHECK_INTERVAL_HOURS) ??
    DEFAULT_EXPIRATION_CHECK_INTERVAL_HOURS
  const maxSizeBytes = maxTotalSizeMB * 1024 * 1024

  return {
    acceptedTypes,
    acceptedMimeTypes: buildAcceptedMimeTypes(acceptedTypes),
    maxTotalSizeMB,
    maxFileSize: maxSizeBytes,
    maxTotalSize: maxSizeBytes,
    maxFileCount,
    fileExpirationCheckIntervalHours,
  }
}
