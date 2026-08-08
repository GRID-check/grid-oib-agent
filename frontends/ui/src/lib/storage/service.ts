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
import { findOrganization } from '@/lib/organizations/repository'
import { aggregateStorageUsage, sumStorageBytes, type StorageUsageByScope } from './repository'
import { InsufficientStorageError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
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

/**
 * The effective quota for a settings bag that has already been read.
 *
 * Pure, and separated from {@link getStorageQuotaBytes} because the platform
 * overview holds every organization's settings row in memory already: resolving
 * the quota there used to call `getStorageQuotaBytes` per row, which is a
 * database round trip per tenant for a value the caller was holding. The rule
 * lives here so both callers apply the same one.
 */
export function effectiveQuotaFromSettings(settings: Record<string, unknown>): number | null {
  const configured = settings[STORAGE_QUOTA_SETTING]
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured)
  }
  // An explicit null means "this org is deliberately unlimited" and must not
  // fall through to the platform default.
  if (configured === null) return null
  return platformDefaultQuotaBytes()
}

/** Read the effective quota: the org's own value, else the platform default. */
export async function getStorageQuotaBytes(organizationId: string): Promise<number | null> {
  const { settings } = await getOrgSettings(organizationId)
  return effectiveQuotaFromSettings(settings)
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
  // Refuse an organization Grid has never heard of. `updateOrgSettings` upserts,
  // so without this a mistyped id in the URL silently creates a settings row and
  // an audit event for a tenant that does not exist — a quota nobody will ever
  // see, attached to nothing, in the record of who changed what.
  //
  // "Known" is deliberately the same set the platform console lists: a settings
  // row OR at least one document. Requiring the settings row alone would reject
  // exactly the tenants an operator most wants to bound — a busy organization
  // that has never opened its own settings has no row.
  const usage = await aggregateStorageUsage(organizationId)
  if (usage.total.documents === 0 && (await findOrganization(organizationId)) === null) {
    throw new NotFoundError('Organization not found')
  }

  if (quotaBytes !== null) {
    // Defence in depth, not the boundary check: the route's zod schema makes
    // every non-positive value a 400 before this runs (see
    // `@/lib/storage/contract`), which is what leaves 422 with exactly one
    // meaning for the caller. This stays because the service is callable from
    // elsewhere and the invariant is the service's, not the route's.
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
      throw new UnprocessableError('Quota must be a positive number of bytes')
    }
    if (quotaBytes < usage.total.bytes) {
      throw new UnprocessableError(
        'Quota is below the storage this organization already uses',
        { usedBytes: usage.total.bytes, requestedQuotaBytes: quotaBytes }
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

  // `usage` is the reading taken above, deliberately not re-fetched: this write
  // changed the quota, not the bytes, and a second aggregate here would only
  // widen the window in which the number returned disagrees with the number
  // validated against.
  return { usage, quotaBytes: await getStorageQuotaBytes(organizationId) }
}
