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

const countDocumentsByProject = vi.fn()
vi.mock('@/lib/documents/repository', () => ({
  countDocumentsByProject: (...args: unknown[]) => countDocumentsByProject(...args),
}))

const lastProjectActivityByUser = vi.fn()
vi.mock('@/lib/conversations/repository', () => ({
  lastProjectActivityByUser: (...args: unknown[]) => lastProjectActivityByUser(...args),
  listConversationIdsForProject: vi.fn(),
}))

import { getProjectsGridData, listProjects } from './service'
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
    // A legacy admin session: role slug, no claims. `hasPermission`'s bounded
    // catalog implication carries it, so nobody re-logs-in for the fix.
    const visible = await listProjects(session({ role: 'admin' }))

    expect(visible).toHaveLength(3)
    expect(check).not.toHaveBeenCalled()
  })

  it('the bypass is the PERMISSION, not the role slug', async () => {
    // This pair is what fails if `hasPermission(...)` is reverted to
    // `session.role === 'admin'`. The old test above passes under BOTH rules,
    // so on its own it pinned nothing.
    const custom = await listProjects(
      session({ role: 'acme-owner', permissions: ['org:projects:administer'] })
    )
    expect(custom).toHaveLength(3)
    expect(check).not.toHaveBeenCalled()

    // …and a role that holds org permissions but not THAT one is filtered like
    // anyone else.
    check.mockResolvedValue({ authorized: false })
    const auditor = await listProjects(
      session({ role: 'org-auditor', permissions: ['org:audit:view'] })
    )
    expect(auditor).toHaveLength(0)
    expect(check).toHaveBeenCalled()
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

/**
 * The grid's derived reads must inherit the FGA filtering above rather than
 * re-deriving their own scope — a document count or an activity timestamp for a
 * project the caller cannot open is the same leak in a different shape.
 */
describe('getProjectsGridData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listProjectsInOrg.mockResolvedValue([ALPHA, BETA, GAMMA])
    countDocumentsByProject.mockResolvedValue({ proj_beta: 4 })
    lastProjectActivityByUser.mockResolvedValue({ proj_beta: '2026-08-05T09:00:00.000Z' })
  })

  it('asks for activity for the caller, and only for the projects they can reach', async () => {
    check.mockImplementation(({ resourceExternalId }: { resourceExternalId: string }) =>
      Promise.resolve({ authorized: resourceExternalId === 'proj_beta' })
    )

    const data = await getProjectsGridData(session())

    expect(lastProjectActivityByUser).toHaveBeenCalledWith('org_1', 'user_1', ['proj_beta'])
    expect(countDocumentsByProject).toHaveBeenCalledWith('org_1', ['proj_beta'])
    expect(data.projects.map((project) => project.id)).toEqual(['proj_beta'])
    expect(data.viewerActivity).toEqual({ proj_beta: '2026-08-05T09:00:00.000Z' })
    expect(data.documentCounts).toEqual({ proj_beta: 4 })
  })

  it('returns an empty activity map rather than failing when nobody has worked anywhere', async () => {
    check.mockResolvedValue({ authorized: true })
    lastProjectActivityByUser.mockResolvedValue({})

    const data = await getProjectsGridData(session())

    expect(data.viewerActivity).toEqual({})
    expect(data.projects).toHaveLength(3)
  })
})
