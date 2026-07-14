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

vi.mock('@/lib/compliance/repository', () => ({
  isDeletionUnderHold: vi.fn(),
}))

vi.mock('@/lib/documents/repository', () => ({
  findDocumentIdByObjectKey: vi.fn(),
}))

import { findProjectTenancy } from '@/lib/projects/repository'
import { resolveOrganizationMembershipId } from '@/lib/auth/session'
import { isDeletionUnderHold } from '@/lib/compliance/repository'
import { findDocumentIdByObjectKey } from '@/lib/documents/repository'
import { checkFileAccess, checkFileDeletable } from './file-access'

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

describe('checkFileDeletable (legal-hold gate)', () => {
  const delReq = {
    organizationId: 'org_acme',
    projectId: 'proj_atlas',
    objectKey: 'org/org_acme/project/proj_atlas/doc/d1/plan.pdf',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_acme', deletedAt: null } as never)
    vi.mocked(findDocumentIdByObjectKey).mockResolvedValue('d1')
    vi.mocked(isDeletionUnderHold).mockResolvedValue(false)
  })

  it('deletable when no hold covers the object', async () => {
    await expect(checkFileDeletable(delReq)).resolves.toEqual({ deletable: true })
    expect(isDeletionUnderHold).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      projectId: 'proj_atlas',
      documentId: 'd1',
    })
  })

  it('NOT deletable when a hold covers the object', async () => {
    vi.mocked(isDeletionUnderHold).mockResolvedValue(true)
    await expect(checkFileDeletable(delReq)).resolves.toEqual({ deletable: false })
  })

  it('still checks org/project holds for a raw file with no document row', async () => {
    vi.mocked(findDocumentIdByObjectKey).mockResolvedValue(null)
    await checkFileDeletable(delReq)
    expect(isDeletionUnderHold).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      projectId: 'proj_atlas',
      documentId: null,
    })
  })

  it('fails closed (not deletable) for a cross-tenant project, never touching holds', async () => {
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_other', deletedAt: null } as never)
    await expect(checkFileDeletable(delReq)).resolves.toEqual({ deletable: false })
    expect(isDeletionUnderHold).not.toHaveBeenCalled()
  })

  it('fails closed for an unknown / soft-deleted project', async () => {
    vi.mocked(findProjectTenancy).mockResolvedValue(null as never)
    await expect(checkFileDeletable(delReq)).resolves.toEqual({ deletable: false })
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_acme', deletedAt: new Date() } as never)
    await expect(checkFileDeletable(delReq)).resolves.toEqual({ deletable: false })
  })
})
