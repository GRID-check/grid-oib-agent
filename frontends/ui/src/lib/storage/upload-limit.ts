/**
 * Per-organization upload limit: the largest single file, other than a
 * building model, that an organization may upload.
 *
 * ## Where the number comes from
 *
 * The deployment default is `FILE_UPLOAD_MAX_SIZE_MB` (100 MB). Platform staff
 * may give one organization its own value, stored as `maxUploadFileBytes` in
 * the `organizations.settings` bag beside the storage quota, for the same
 * reason the quota lives there (one nullable scalar, no history requirement).
 * It is platform-owned (`PLATFORM_OWNED_SETTINGS`): a tenant that could raise
 * its own limit would not be limited.
 *
 * ## The range, and why it has a ceiling
 *
 * At least 1 MB, at most the transport ceiling `requestBodyLimitBytes()`. That
 * ceiling is fixed at boot in `next.config.ts` (`proxyClientMaxBodySize`), so
 * bytes beyond it are cut off in front of the handler: an organization limit
 * above it would promise an upload the server can never receive. A stored value
 * that a later, lower ceiling overtakes is read as the ceiling rather than
 * trusted, so the refusal message never names a size that cannot arrive.
 *
 * ## Models keep their own ceiling
 *
 * A `.ifc`/`.ifczip` is measured against `BIM_MAX_IFC_BYTES`, not this. That
 * one number is also the extractor's parse limit and a term in the transport
 * ceiling (`@/shared/config/request-body-limit`), so letting an organization
 * value override it for uploads would admit a model the extractor then refuses.
 */

import 'server-only'
import { FileTooLargeError, UnprocessableError, formatMegabytes } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { GridSession } from '@/lib/auth/types'
import { requirePlatformPermission } from '@/lib/authz/platform'
import { isIfcFilename } from '@/lib/bim/types'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getCached, invalidateCached } from '@/lib/cache'
import { getOrgSettings, updatePlatformOwnedOrgSettings } from '@/lib/organizations/service'
import {
  maxDocumentBytesFrom,
  maxIfcBytesFrom,
  requestBodyLimitBytes,
} from '@/shared/config/request-body-limit'
import { MIN_UPLOAD_LIMIT_BYTES, judgeUploadLimitBytes } from './contract'
import { readKnownOrganizationUsage } from './known-organization'

/** Key under `organizations.settings` holding the organization's own limit, in bytes. */
export const MAX_UPLOAD_FILE_SETTING = 'maxUploadFileBytes'

/** What a per-organization limit may be, for this deployment. */
export interface UploadLimitBounds {
  /** The limit an organization without its own value gets. */
  defaultBytes: number
  /** The smallest value platform staff may set. */
  minBytes: number
  /** The largest: the transport ceiling, fixed at boot. */
  ceilingBytes: number
}

export function uploadLimitBounds(
  env: Record<string, string | undefined> = process.env
): UploadLimitBounds {
  return {
    defaultBytes: maxDocumentBytesFrom(env),
    minBytes: MIN_UPLOAD_LIMIT_BYTES,
    ceilingBytes: requestBodyLimitBytes(env),
  }
}

/** The organization's own value from a settings bag already read, or null when it has none. */
export function configuredUploadLimit(settings: Record<string, unknown>): number | null {
  const value = settings[MAX_UPLOAD_FILE_SETTING]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

/** The limit in force: the organization's own value held to the bounds, else the default. */
export function effectiveUploadLimit(configured: number | null, bounds: UploadLimitBounds): number {
  if (configured === null) return bounds.defaultBytes
  return Math.min(Math.max(configured, bounds.minBytes), bounds.ceilingBytes)
}

const UPLOAD_LIMIT_CACHE_TTL_MS = 30_000
const uploadLimitCacheKey = (organizationId: string): string => `uploadlimit:${organizationId}`

/**
 * The per-file upload limit in force for an organization, in bytes.
 *
 * Read on every upload and on every page render (the root layout hands it to
 * the browser), so the organization's own value is cached briefly and
 * invalidated by {@link setMaxUploadFileBytes}. The cache holds the STORED value
 * rather than the effective one: the bounds come from this process's env, and a
 * replica booted with a different ceiling must apply its own.
 */
export async function getEffectiveMaxUploadBytes(organizationId: string): Promise<number> {
  const configured = await getCached(
    uploadLimitCacheKey(organizationId),
    UPLOAD_LIMIT_CACHE_TTL_MS,
    async () => configuredUploadLimit((await getOrgSettings(organizationId)).settings)
  )
  return effectiveUploadLimit(configured, uploadLimitBounds())
}

/**
 * Refuse a file larger than its organization may upload. Server-side, so it
 * holds when the browser's check (a courtesy) is bypassed.
 *
 * The limit is {@link getEffectiveMaxUploadBytes}, the number the root layout
 * hands the browser. A model is measured against `BIM_MAX_IFC_BYTES` instead,
 * which no organization value overrides (see the module note). Whether a `.ifc`
 * may be uploaded at all is `assertUploadTypeAllowed`'s job and has already run;
 * without a filename the caller gets the general limit, the safe direction.
 *
 * Takes the organization rather than a number, so no caller can judge a file
 * against the wrong limit or forget that there is a per-organization one.
 */
export async function assertFileSizeAllowed(
  organizationId: string,
  sizeBytes: number,
  filename?: string
): Promise<void> {
  const ceiling =
    filename && isIfcFilename(filename)
      ? maxIfcBytesFrom(process.env)
      : await getEffectiveMaxUploadBytes(organizationId)
  if (sizeBytes > ceiling) {
    throw new FileTooLargeError({ fileSize: sizeBytes, maxSizeBytes: ceiling })
  }
}

export interface UploadLimitState {
  /** The organization's own value, or null when it follows the deployment default. */
  maxUploadFileBytes: number | null
  /** The limit in force. */
  effectiveMaxUploadFileBytes: number
}

/**
 * Set (or clear, with null) an organization's per-file upload limit. PLATFORM ONLY.
 *
 * Shaped like `setStorageQuota`, for the same reasons: the permission is
 * checked here, first, so the function is safe whatever calls it; an unknown
 * organization is refused rather than given a settings row; the write goes
 * through the platform-tier merge that `updateOrgSettings` refuses to tenants.
 *
 * Refuses a value above the transport ceiling with a 422 naming both bounds.
 * The 1 MB floor is the route schema's (a 400), and is re-checked here only
 * because the invariant belongs to the service.
 */
export async function setMaxUploadFileBytes(
  session: GridSession,
  organizationId: string,
  maxUploadFileBytes: number | null,
  request?: Request
): Promise<UploadLimitState> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsManage)
  await readKnownOrganizationUsage(organizationId)

  const bounds = uploadLimitBounds()
  if (maxUploadFileBytes !== null && !judgeUploadLimitBytes(maxUploadFileBytes, bounds.ceilingBytes).ok) {
    throw new UnprocessableError(
      `Upload limit must be between ${formatMegabytes(bounds.minBytes)} MB and ` +
        `${formatMegabytes(bounds.ceilingBytes)} MB, the largest request this deployment accepts`,
      { ...bounds, requestedBytes: maxUploadFileBytes }
    )
  }

  await updatePlatformOwnedOrgSettings(session, organizationId, {
    settings: { [MAX_UPLOAD_FILE_SETTING]: maxUploadFileBytes },
  })
  await invalidateCached(uploadLimitCacheKey(organizationId))

  await recordAuditEvent({
    organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.upload_limit.updated',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { maxUploadFileBytes: maxUploadFileBytes ?? 0 },
    request,
  })

  return {
    maxUploadFileBytes,
    effectiveMaxUploadFileBytes: effectiveUploadLimit(maxUploadFileBytes, bounds),
  }
}
