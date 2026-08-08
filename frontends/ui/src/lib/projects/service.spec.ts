/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const check = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { check } }),
}))

const listProjectsInOrg = vi.fn()
vi.mock('./repository', () => ({
  listProjectsInOrg: (...args: unknown[]) => listProjectsInOrg(...args),
  findProjectInOrg: vi.fn(),
  insertProject: vi.fn(),
  renameProjectInOrg: vi.fn(),
  restoreProjectIfPending: vi.fn(),
  setProjectWorkosResourceId: vi.fn(),
  softDeleteProjectAndEnqueue: vi.fn(),
}))

import { listProjects } from './service'
import { makeProject } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'

const session = (overrides: Partial<AuthorizedSession> = {}): AuthorizedSession => ({
  userId: 'user_1',
  email: 'someone@grid.com',
  name: 'Someone',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
  ...overrides,
})

const ALPHA = makeProject({ id: 'proj_alpha', name: 'Alpha', organizationId: 'org_1' })
const BETA = makeProject({ id: 'proj_beta', name: 'Beta', organizationId: 'org_1' })
const GAMMA = makeProject({ id: 'proj_gamma', name: 'Gamma', organizationId: 'org_1' })

/**
 * The listing used to return every project in the organization while the detail
 * route gated on per-project FGA — so `project-viewer`/`editor`/`admin` decided
 * who could OPEN a project but not who could SEE that it exists. These tests
 * would have failed against that behaviour.
 */
describe('listProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listProjectsInOrg.mockResolvedValue([ALPHA, BETA, GAMMA])
    delete process.env.GRID_AUTHZ_CACHE_TTL_MS
  })

  it('returns ONLY the projects the member holds project:view on', async () => {
    check.mockImplementation(({ resourceExternalId }: { resourceExternalId: string }) =>
      Promise.resolve({ authorized: resourceExternalId === 'proj_beta' })
    )

    const visible = await listProjects(session())

    expect(visible.map((project) => project.id)).toEqual(['proj_beta'])
  })

  it('does not leak the names of projects the member cannot reach', async () => {
    check.mockResolvedValue({ authorized: false })

    const visible = await listProjects(session())

    expect(visible).toEqual([])
    // The tenant's project names must not survive anywhere in the response.
    expect(JSON.stringify(visible)).not.toContain('Alpha')
  })

  it('checks project:view against the caller membership, once per project', async () => {
    check.mockResolvedValue({ authorized: true })

    await listProjects(session())

    expect(check).toHaveBeenCalledTimes(3)
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationMembershipId: 'om_1',
        permissionSlug: 'project:view',
        resourceTypeSlug: 'project',
      })
    )
  })

  it('org admins still see every project in their organization (named bypass)', async () => {
    const visible = await listProjects(session({ role: 'admin' }))

    expect(visible).toHaveLength(3)
    expect(check).not.toHaveBeenCalled()
  })

  it('fails closed per project: one broken check hides that project, not the page', async () => {
    check.mockImplementation(({ resourceExternalId }: { resourceExternalId: string }) =>
      resourceExternalId === 'proj_beta'
        ? Promise.reject(new Error('workos unreachable'))
        : Promise.resolve({ authorized: true })
    )

    const visible = await listProjects(session())

    expect(visible.map((project) => project.id)).toEqual(['proj_alpha', 'proj_gamma'])
  })

  it('never reaches outside the caller organization', async () => {
    check.mockResolvedValue({ authorized: true })

    await listProjects(session({ organizationId: 'org_1' }))

    expect(listProjectsInOrg).toHaveBeenCalledWith('org_1', { order: 'newest' })
  })
})
