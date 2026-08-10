import type { FileUploadConfig } from '@/shared/context'
// One source of truth for the IFC file identity: `@/lib/bim/types` is pure
// types + constants with no server-only import, so the client bundle can read
// it too and the accept-list cannot drift from the pipeline that consumes it.
import { IFC_EXTENSIONS, IFC_MIME_TYPES } from '@/lib/bim/types'
import { maxIfcBytesFrom } from './request-body-limit'

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
// `.ifc` is NOT here: like images, it is governed by a product decision (the
// `ifc-models` flag) rather than by the env list, so it is stripped
// unconditionally and re-added only when the flag allows. Unlike images it has
// no capability half — extraction runs in this process, so there is no
// dependency that could be missing (see FEATURE_FLAGS.ifcModels).
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
  // No IANA type is registered for IFC, so browsers send
  // `application/octet-stream` (or nothing at all) for a `.ifc` file. The MIME
  // list is therefore advisory — the extension is what decides, here and in the
  // BFF allow-list — and a type-less file is already accepted by
  // `isValidMimeType`, so no empty-string entry is needed.
  '.ifc': [...IFC_MIME_TYPES, 'application/octet-stream'],
  '.ifczip': ['application/zip', 'application/octet-stream'],
}

/**
 * Image extensions gated by availability = `image-upload` flag AND VLM
 * capability (FB-15a). They are stripped from the env accept-list
 * unconditionally and re-added only when both hold, so the file picker +
 * drag-drop offer them exactly when ingestion would succeed.
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const

/**
 * IFC extensions gated by the `ifc-models` flag alone. Same "never controlled
 * by the env list" treatment as images — an `.ifc` in
 * `FILE_UPLOAD_ACCEPTED_TYPES` on a deployment with the feature off would let a
 * user upload a model that no surface can open — but with no capability half,
 * because extraction has no infrastructure dependency to derive one from.
 */
export const IFC_UPLOAD_EXTENSIONS = IFC_EXTENSIONS

const isGatedExtension = (ext: string): boolean => {
  const lower = ext.toLowerCase()
  return (
    IMAGE_EXTENSIONS.includes(lower as (typeof IMAGE_EXTENSIONS)[number]) ||
    IFC_UPLOAD_EXTENSIONS.includes(lower as (typeof IFC_UPLOAD_EXTENSIONS)[number])
  )
}

/** Drop every flag-governed extension, leaving only env-controlled types. */
const stripGatedExtensions = (acceptedTypes: string): string =>
  acceptedTypes
    .split(',')
    .map((ext) => ext.trim())
    .filter((ext) => ext && !isGatedExtension(ext))
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
  options: { imageUploadEnabled?: boolean; vlmAvailable?: boolean; ifcUploadEnabled?: boolean } = {}
): FileUploadConfig => {
  // `imageUploadEnabled` defaults TRUE (flag fails open when enforcement is
  // off); `vlmAvailable` defaults FALSE (fail-closed — a caller that doesn't
  // supply the derived capability gets NO images, matching the base list). Real
  // callers pass both resolved values. `ifcUploadEnabled` defaults TRUE for the
  // same reason as the image FLAG: a flag fails open, a capability fails closed,
  // and IFC has no capability.
  const { imageUploadEnabled = true, vlmAvailable = false, ifcUploadEnabled = true } = options
  const rawAcceptedTypes = env.FILE_UPLOAD_ACCEPTED_TYPES || DEFAULT_ACCEPTED_TYPES

  // Flag-governed types are never controlled by the env list: strip them
  // unconditionally, then re-add the ones whose gate passes. Env-listed images
  // with no VLM stay excluded — no silent-failure uploads.
  const imagesAllowed = imageUploadEnabled && vlmAvailable
  const baseTypes = stripGatedExtensions(rawAcceptedTypes)
  const acceptedTypes = [
    baseTypes,
    ...(imagesAllowed ? IMAGE_EXTENSIONS : []),
    ...(ifcUploadEnabled ? IFC_UPLOAD_EXTENSIONS : []),
  ]
    .filter(Boolean)
    .join(',')

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

  // A `.ifc` gets its own, much larger ceiling, shared with the extractor via
  // `maxIfcBytesFrom` so the two layers cannot disagree. An ordinary
  // Einreichung model is 50–500 MB and the general document limit (100 MB by
  // default) was sized for PDFs, so a model was refused for being a large
  // FILE rather than for anything to do with IFC.
  // NOT folded into `maxTotalSize`: raising the batch ceiling here would raise
  // it for every file type, so three 80 MB PDFs would start passing a limit
  // set at 100 MB. The batch ceiling is lifted per-batch, and only for a batch
  // that actually contains a model — see `validateFileUpload`.
  const maxIfcFileSize = ifcUploadEnabled ? maxIfcBytesFrom(env) : 0

  return {
    acceptedTypes,
    acceptedMimeTypes: buildAcceptedMimeTypes(acceptedTypes),
    maxTotalSizeMB,
    maxFileSize: maxSizeBytes,
    maxIfcFileSize,
    maxTotalSize: maxSizeBytes,
    maxFileCount,
    fileExpirationCheckIntervalHours,
    imageUploadBlockedReason,
  }
}
