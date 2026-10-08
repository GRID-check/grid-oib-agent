/**
 * Refuse a platform write aimed at an organization Grid has never heard of.
 *
 * Shared by every platform-owned storage setting (the quota, the per-file
 * upload limit). `updatePlatformOwnedOrgSettings` upserts, so without this a
 * mistyped id in the URL silently creates a settings row and an audit event for
 * a tenant that does not exist: a limit nobody will ever see, attached to
 * nothing, in the record of who changed what.
 *
 * "Known" is deliberately the same set the platform console lists: a settings
 * row OR at least one document. Requiring the settings row alone would reject
 * exactly the tenants an operator most wants to bound, since a busy
 * organization that has never opened its own settings has no row.
 *
 * Callers check platform permission BEFORE calling this: `NotFoundError` vs
 * `Forbidden` on a guessed id is an enumeration oracle over every organization.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import { findOrganization } from '@/lib/organizations/repository'
import { aggregateStorageUsage, type StorageUsageByScope } from './repository'

/** The organization's usage, read once; throws `NotFoundError` for an unknown id. */
export async function readKnownOrganizationUsage(
  organizationId: string
): Promise<StorageUsageByScope> {
  const usage = await aggregateStorageUsage(organizationId)
  if (usage.total.documents === 0 && (await findOrganization(organizationId)) === null) {
    throw new NotFoundError('Organization not found')
  }
  return usage
}
