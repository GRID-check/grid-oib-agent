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
import { InsufficientStorageError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'

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
}

/**
 * Usage + quota for the caller's own organization. READ ONLY.
 *
 * Readable by every member: how full the shared drive is is not privileged, and
 * a member whose upload was refused needs to see why. Nobody inside the tenant
 * can change the number — see {@link setStorageQuota}.
 */
export async function getStorageOverview(session: AuthorizedSession): Promise<StorageOverview> {
  const [usage, quotaBytes] = await Promise.all([
    aggregateStorageUsage(session.organizationId),
    getStorageQuotaBytes(session.organizationId),
  ])

  return { usage, quotaBytes }
}

/**
 * Usage + quota for ANY organization, by id — the platform-owner read.
 *
 * Separate from {@link getStorageOverview} because that one derives the org
 * from the caller's session, which is exactly what a platform owner browsing
 * someone else's tenant does not have.
 */
export async function getOrganizationStorage(
  organizationId: string
): Promise<StorageOverview> {
  const [usage, quotaBytes] = await Promise.all([
    aggregateStorageUsage(organizationId),
    getStorageQuotaBytes(organizationId),
  ])
  return { usage, quotaBytes }
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
 * Set (or clear, with null) an organization's storage quota. PLATFORM ONLY.
 *
 * Deliberately unreachable from inside the tenant, and deliberately taking an
 * explicit `organizationId` instead of reading one off the caller's session: a
 * quota is a commercial constraint the platform operator imposes, and a limit
 * the constrained party can raise is not a limit. Same reason
 * `platform_model_defaults` sits at the platform tier — the tenant sees the
 * number and plans around it, only the operator sets it.
 *
 * Authorization is `platformApiRoute`'s `requirePlatformOwner`, which runs
 * before the handler and so cannot be lost by editing it. Takes a `GridSession`
 * because a platform owner browsing another org holds no membership in it, and
 * does no check of its own — the route is the gate and names itself in its
 * `enforcedBy` posture.
 *
 * Refuses a quota below what the org already stores: accepting one strands the
 * tenant in a state no upload can fix while doing nothing about the bytes
 * already there. Freeing space first is the only honest order of operations.
 */
export async function setStorageQuota(
  session: GridSession,
  organizationId: string,
  quotaBytes: number | null,
  request?: Request
): Promise<StorageOverview> {
  if (quotaBytes !== null) {
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
      throw new UnprocessableError('Quota must be a positive number of bytes')
    }
    const usedBytes = await sumStorageBytes(organizationId)
    if (quotaBytes < usedBytes) {
      throw new UnprocessableError(
        'Quota is below the storage this organization already uses',
        { usedBytes, requestedQuotaBytes: quotaBytes }
      )
    }
  }

  await updateOrgSettings(organizationId, {
    settings: { [STORAGE_QUOTA_SETTING]: quotaBytes === null ? null : Math.floor(quotaBytes) },
  })

  await recordAuditEvent({
    organizationId: organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.storage_quota.updated',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { quotaBytes: quotaBytes === null ? 0 : Math.floor(quotaBytes) },
    request,
  })

  const [usage, effective] = await Promise.all([
    aggregateStorageUsage(organizationId),
    getStorageQuotaBytes(organizationId),
  ])
  return { usage, quotaBytes: effective }
}
