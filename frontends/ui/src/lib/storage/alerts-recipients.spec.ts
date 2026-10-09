import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/inbox/repository', () => ({ archiveInboxItemsOfType: vi.fn(), findLiveInboxGroupKeys: vi.fn() }))
vi.mock('./repository', () => ({ aggregateStorageUsageByOrganization: vi.fn() }))
vi.mock('./service', () => ({ getStorageQuotaBytes: vi.fn() }))
vi.mock('@/lib/organizations/service', () => ({ listOrganizationMembersWithRoles: vi.fn() }))
vi.mock('@/lib/authz/org-role-permissions', () => ({ orgRoleHoldsPermission: vi.fn() }))

import { orgRoleHoldsPermission } from '@/lib/authz/org-role-permissions'
import { listOrganizationMembersWithRoles } from '@/lib/organizations/service'
import { findStorageAlertRecipients, STORAGE_ALERT_PERMISSION } from './alerts'

/**
 * A custom role an office built for itself in WorkOS (here a Geschäftsführung
 * holding org:settings:manage) is somebody who can act on a full disk. The
 * recipients used to come from the catalog alone, which has never heard of it.
 */
describe('findStorageAlertRecipients', () => {
  it("asks WorkOS about each member's role within the organization, custom roles included", async () => {
    vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([
      { id: 'u_gf', status: 'active', roleSlug: 'org-geschaeftsfuehrung' },
      { id: 'u_intern', status: 'active', roleSlug: 'member' },
      { id: 'u_left', status: 'inactive', roleSlug: 'org-geschaeftsfuehrung' },
    ] as Awaited<ReturnType<typeof listOrganizationMembersWithRoles>>)
    vi.mocked(orgRoleHoldsPermission).mockImplementation(async (role) => role === 'org-geschaeftsfuehrung')

    await expect(findStorageAlertRecipients('org_1')).resolves.toEqual(['u_gf'])
    expect(orgRoleHoldsPermission).toHaveBeenCalledWith('org-geschaeftsfuehrung', STORAGE_ALERT_PERMISSION, 'org_1')
  })
})
