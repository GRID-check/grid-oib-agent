/**
 * Storage service — how much object storage an organization is using, and the
 * quota that bounds it.
 *
 * Why a quota exists at all: before this, nothing in the stack limited how many
 * bytes a tenant could store. The SeaweedFS PVC size and `-volume.max` were the
 * only ceilings, and reaching either is a cluster-wide outage rather than one
 * tenant hitting a limit — every other tenant's uploads fail too. A per-org
 * quota turns a shared failure into a scoped, explainable one.
 *
 * The quota lives in the `organizations.settings` jsonb bag rather than its own
 * table (see the bag's own note in schema/organizations.ts): it is one nullable
 * number per org with no history requirement, so a table plus a migration plus
 * an RLS registration would all be ceremony around a single scalar. Budget
 * policies earn their table because they supersede and must stay auditable;
 * this does not.
 */

import 'server-only'
import { getOrgSettings, updateOrgSettings } from '@/lib/organizations/service'
import { aggregateStorageUsage, sumStorageBytes, type StorageUsageByScope } from './repository'
import { ForbiddenError, InsufficientStorageError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { canManageStorage } from '@/lib/authz/organizations'
import type { AuthorizedSession } from '@/lib/auth/types'

/** Key under `organizations.settings` holding the quota, in bytes. */
export const STORAGE_QUOTA_SETTING = 'storageQuotaBytes'

/**
 * Fleet-wide default applied when an org has set no quota of its own.
 *
 * Unset (the default) means unlimited, which is what every existing deployment
 * already had — introducing a quota must not retroactively block tenants who
 * were never told there was a limit. Operators opt the fleet in by setting
 * `GRID_DEFAULT_STORAGE_QUOTA_BYTES`; an org-level value always wins.
 */
function platformDefaultQuotaBytes(): number | null {
  const raw = process.env.GRID_DEFAULT_STORAGE_QUOTA_BYTES
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

/** Read the effective quota: the org's own value, else the platform default. */
export async function getStorageQuotaBytes(organizationId: string): Promise<number | null> {
  const { settings } = await getOrgSettings(organizationId)
  const configured = settings[STORAGE_QUOTA_SETTING]
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured)
  }
  // An explicit null means "this org is deliberately unlimited" and must not
  // fall through to the platform default.
  if (configured === null) return null
  return platformDefaultQuotaBytes()
}

export interface StorageOverview {
  usage: StorageUsageByScope
  /** Effective quota in bytes, or null when unlimited. */
  quotaBytes: number | null
  /** Whether the caller may change the quota (drives the UI, not the gate). */
  canManage: boolean
}

/**
 * Usage + quota for the caller's own organization.
 *
 * Readable by every member: knowing how full the shared drive is, is not
 * privileged information, and a member who cannot upload needs to see why.
 * Only the quota WRITE requires `org:settings:manage`.
 */
export async function getStorageOverview(session: AuthorizedSession): Promise<StorageOverview> {
  const [usage, quotaBytes] = await Promise.all([
    aggregateStorageUsage(session.organizationId),
    getStorageQuotaBytes(session.organizationId),
  ])

  return { usage, quotaBytes, canManage: canManageStorage(session) }
}

/**
 * Refuse an upload that would take the organization past its quota.
 *
 * Called from the upload paths BEFORE any bytes reach SeaweedFS, so a refused
 * upload leaves nothing behind to clean up. Fail-CLOSED is deliberate here and
 * the opposite of the abuse limiter's posture: a limiter that fails open costs
 * a little extra traffic, whereas a quota that fails open costs disk that is
 * shared with every other tenant and with the Postgres backup archive.
 */
export async function assertWithinStorageQuota(
  organizationId: string,
  incomingBytes: number
): Promise<void> {
  const quotaBytes = await getStorageQuotaBytes(organizationId)
  if (quotaBytes === null) return

  const usedBytes = await sumStorageBytes(organizationId)
  if (usedBytes + incomingBytes <= quotaBytes) return

  throw new InsufficientStorageError(
    'This organization has no storage space left. Delete documents or ask an administrator to raise the quota.',
    { quotaBytes, usedBytes, requestedBytes: incomingBytes }
  )
}

/**
 * Set (or clear, with null) the organization's storage quota.
 *
 * Refuses a quota below what the org already stores: accepting one would put
 * every subsequent upload into a state the uploader cannot fix, while silently
 * doing nothing about the bytes already there. Freeing space first is the only
 * honest order of operations.
 */
export async function setStorageQuota(
  session: AuthorizedSession,
  quotaBytes: number | null,
  request?: Request
): Promise<StorageOverview> {
  if (!canManageStorage(session)) throw new ForbiddenError()

  if (quotaBytes !== null) {
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
      throw new UnprocessableError('Quota must be a positive number of bytes')
    }
    const usedBytes = await sumStorageBytes(session.organizationId)
    if (quotaBytes < usedBytes) {
      throw new UnprocessableError(
        'Quota is below the storage this organization already uses',
        { usedBytes, requestedQuotaBytes: quotaBytes }
      )
    }
  }

  await updateOrgSettings(session.organizationId, {
    settings: { [STORAGE_QUOTA_SETTING]: quotaBytes === null ? null : Math.floor(quotaBytes) },
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.storage_quota.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { quotaBytes: quotaBytes === null ? 0 : Math.floor(quotaBytes) },
    request,
  })

  return getStorageOverview(session)
}
