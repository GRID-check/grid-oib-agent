import type { FileUploadConfig } from '@/shared/context'

// Doctrine (see AGENTS.md): flags are product decisions, env vars are real
// infrastructure dependencies, a capability is DERIVED from the dependency, and
// availability = flag AND capability. Image upload follows it exactly: the
// `image-upload` WorkOS flag is the product decision; a configured VLM
// (AIQ_VLM_API_KEY / provider fallback) is the dependency; `vlmAvailable` is the
// capability the backend derives from it; images are offered only when the flag
// allows AND the capability is present.
//
// Image types are therefore NEVER controlled by the env accept-list: they are
// stripped from it unconditionally and re-added ONLY when (flag AND capability).
// This closes the old silent-failure hole where a deployment that listed images
// in FILE_UPLOAD_ACCEPTED_TYPES but had no VLM would accept uploads guaranteed
// to fail ingestion. The env list still governs every NON-image type (exotic
// additions, explicit back-compat entries). The EXTENSION_TO_MIME image entries
// below stay so the re-added image extensions resolve their MIME types.
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
 * Image extensions gated by availability = `image-upload` flag AND VLM
 * capability (FB-15a). They are stripped from the env accept-list
 * unconditionally and re-added only when both hold, so the file picker +
 * drag-drop offer them exactly when ingestion would succeed.
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const

const isImageExtension = (ext: string): boolean =>
  IMAGE_EXTENSIONS.includes(ext.toLowerCase() as (typeof IMAGE_EXTENSIONS)[number])

const stripImageExtensions = (acceptedTypes: string): string =>
  acceptedTypes
    .split(',')
    .map((ext) => ext.trim())
    .filter((ext) => ext && !isImageExtension(ext))
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
  options: { imageUploadEnabled?: boolean; vlmAvailable?: boolean } = {}
): FileUploadConfig => {
  // `imageUploadEnabled` defaults TRUE (flag fails open when enforcement is
  // off); `vlmAvailable` defaults FALSE (fail-closed — a caller that doesn't
  // supply the derived capability gets NO images, matching the base list). Real
  // callers pass both resolved values.
  const { imageUploadEnabled = true, vlmAvailable = false } = options
  const rawAcceptedTypes = env.FILE_UPLOAD_ACCEPTED_TYPES || DEFAULT_ACCEPTED_TYPES

  // Images are governed by the capability, never by the env list: strip them
  // unconditionally, then re-add only when (flag AND capability). Env-listed
  // images with no VLM stay excluded — no silent-failure uploads.
  const imagesAllowed = imageUploadEnabled && vlmAvailable
  const nonImageTypes = stripImageExtensions(rawAcceptedTypes)
  const acceptedTypes = imagesAllowed
    ? [nonImageTypes, ...IMAGE_EXTENSIONS].filter(Boolean).join(',')
    : nonImageTypes

  // Distinguish "images off because no VLM" (flag on, capability missing) from
  // "images off because the product flag is off" so the UI can explain the
  // former to admins. null when images are allowed or the flag itself is off.
  const imageUploadBlockedReason: FileUploadConfig['imageUploadBlockedReason'] =
    imageUploadEnabled && !vlmAvailable ? 'vlm-unavailable' : null

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
    imageUploadBlockedReason,
  }
}
