import { beforeEach, describe, expect, it, vi } from 'vitest'

const check = vi.fn()

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { check } }),
}))

// getCached just runs the loader (cache behaviour is tested elsewhere).
vi.mock('@/lib/cache', () => ({
  getCached: (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
  invalidateCachedPrefix: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectTenancy: vi.fn(),
}))

vi.mock('@/lib/auth/session', () => ({
  resolveOrganizationMembershipId: vi.fn(),
}))

import { findProjectTenancy } from '@/lib/projects/repository'
import { resolveOrganizationMembershipId } from '@/lib/auth/session'
import { checkFileAccess } from './file-access'

const req = {
  userId: 'user_1',
  organizationId: 'org_acme',
  projectId: 'proj_atlas',
  permission: 'project:view' as const,
}

describe('checkFileAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_acme', deletedAt: null } as never)
    vi.mocked(resolveOrganizationMembershipId).mockResolvedValue('om_1')
    check.mockResolvedValue({ authorized: true })
  })

  it('allows when tenancy, membership, and FGA all pass', async () => {
    await expect(checkFileAccess(req)).resolves.toEqual({ allow: true })
    expect(check).toHaveBeenCalledWith({
      organizationMembershipId: 'om_1',
      permissionSlug: 'project:view',
      resourceExternalId: 'proj_atlas',
      resourceTypeSlug: 'project',
    })
  })

  it('denies (and never checks FGA) when the project is in another org', async () => {
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_other', deletedAt: null } as never)
    await expect(checkFileAccess(req)).resolves.toEqual({ allow: false })
    expect(check).not.toHaveBeenCalled()
  })

  it('denies when the project is soft-deleted', async () => {
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_acme', deletedAt: new Date() } as never)
    await expect(checkFileAccess(req)).resolves.toEqual({ allow: false })
  })

  it('denies when the user has no org membership', async () => {
    vi.mocked(resolveOrganizationMembershipId).mockResolvedValue(null)
    await expect(checkFileAccess(req)).resolves.toEqual({ allow: false })
    expect(check).not.toHaveBeenCalled()
  })

  it('denies when WorkOS FGA denies', async () => {
    check.mockResolvedValue({ authorized: false })
    await expect(checkFileAccess(req)).resolves.toEqual({ allow: false })
  })
})
