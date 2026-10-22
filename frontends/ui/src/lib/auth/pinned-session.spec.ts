/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({ resolveSubjectMembership: vi.fn(), lookupSubjectMembership: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ enabledFlagsForOrganization: vi.fn() }))
vi.mock('./person', () => ({ resolvePerson: vi.fn() }))
// The real role resolver, over a fake WorkOS: what a role holds is the subject.
const listEnvironmentRoles = vi.fn()
const listOrganizationRoles = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { listEnvironmentRoles, listOrganizationRoles } }),
}))

import { lookupSubjectMembership, resolveSubjectMembership } from '@/lib/authz/project-membership'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { resolvePerson } from './person'
import { resolvePinnedRequesterSession, resolvePinnedRequesterSessionStrict } from './pinned-session'
import { setCacheStore } from '@/lib/cache'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { MapCacheStore } from '@/test-utils/cache-store'

const requester = { userId: 'user_owner', email: 'owner@grid.test', organizationId: 'org_1' }

beforeEach(() => {
  vi.clearAllMocks()
  setCacheStore(new MapCacheStore())
  vi.mocked(resolveSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member', roles: ['member'] })
  vi.mocked(lookupSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member', roles: ['member'] })
  listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'member', permissions: ['org:projects:create'] }] })
  listOrganizationRoles.mockResolvedValue({ data: [] })
  vi.mocked(enabledFlagsForOrganization).mockResolvedValue([])
  vi.mocked(resolvePerson).mockResolvedValue({ name: null, email: null, organizationName: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolvePinnedRequesterSession', () => {
  it('builds the session the requester would have now, from their stored id alone', async () => {
    const session = await resolvePinnedRequesterSession(requester)

    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner')
    expect(session).toMatchObject({
      userId: 'user_owner',
      email: 'owner@grid.test',
      organizationId: 'org_1',
      organizationMembershipId: 'om_1',
      role: 'member',
      // No token: nothing on the filing path forwards one, and none is minted.
      accessToken: '',
      featureFlags: [],
    })
    // Permissions come from what the role holds, never from the caller.
    expect(session?.permissions).toEqual(['org:projects:create'])
    expect(session?.roles).toEqual(['member'])
  })

  it('asks for a fresher membership when the caller names its age (the agent door)', async () => {
    await resolvePinnedRequesterSession(requester, { membershipTtlMs: 60_000 })
    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner', 60_000)
  })

  it('knows the person by name, as a live session does, so an unattended turn is not addressed as nobody', async () => {
    vi.mocked(resolvePerson).mockResolvedValueOnce({
      name: 'Anna Weber', email: 'anna@grid.test', organizationName: 'Atelier Nord',
    })

    const session = await resolvePinnedRequesterSession({ ...requester, email: null })

    expect(resolvePerson).toHaveBeenCalledWith('org_1', 'user_owner')
    // The stored email stands where the row has one; WorkOS fills it where it does not.
    expect(session).toMatchObject({ name: 'Anna Weber', email: 'anna@grid.test', organizationName: 'Atelier Nord' })
    expect((await resolvePinnedRequesterSession(requester))?.email).toBe('owner@grid.test')
  })

  it('is nobody when the requester left the organization', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce(null)

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it('is nobody when the membership carries no role to derive permissions from', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({ organizationMembershipId: 'om_1', role: null, roles: [] })

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it("carries every flag of the requester's organization, asked by that organization", async () => {
    vi.mocked(enabledFlagsForOrganization).mockResolvedValueOnce(['agent-authored-documents', 'image-upload'])

    const session = await resolvePinnedRequesterSession(requester)
    expect(session?.featureFlags).toEqual(['agent-authored-documents', 'image-upload'])
    // The lookup that used to pass the slug as the organization.
    expect(enabledFlagsForOrganization).toHaveBeenCalledWith(requester.organizationId)
  })

  it('lets a failed flag lookup throw, so the background work retries instead of acting with none', async () => {
    vi.mocked(enabledFlagsForOrganization).mockRejectedValueOnce(new Error('workos down'))

    await expect(resolvePinnedRequesterSession(requester)).rejects.toThrow('workos down')
  })
})

/**
 * A pinned session took its permissions from the CATALOG's list for the ONE
 * primary role. A custom role an office built in WorkOS is in no catalog, so
 * its member held nothing in every job run as them, though signed in they
 * could do the work; a second role's grants were dropped the same way.
 */
describe('what a pinned session may do', () => {
  it("holds a custom organization role's permissions, as WorkOS grants them", async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({
      organizationMembershipId: 'om_1', role: 'org-geschaeftsfuehrung', roles: ['org-geschaeftsfuehrung'],
    })
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'org-geschaeftsfuehrung', permissions: ['org:projects:administer', 'org:audit:view'] }],
    })

    const session = await resolvePinnedRequesterSession(requester)

    expect(listOrganizationRoles).toHaveBeenCalledWith('org_1')
    expect(session && hasPermission(session, ORG_PERMISSIONS.projectsAdminister)).toBe(true)
    expect(session && hasPermission(session, ORG_PERMISSIONS.auditView)).toBe(true)
  })

  it('holds a custom environment role the catalog has never heard of', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({
      organizationMembershipId: 'om_1', role: 'acme-owner', roles: ['acme-owner'],
    })
    listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'acme-owner', permissions: ['org:projects:administer'] }] })

    const session = await resolvePinnedRequesterSession(requester)
    expect(session?.permissions).toEqual(['org:projects:administer'])
  })

  it("carries every role's permissions, not only the primary one's", async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({
      organizationMembershipId: 'om_1', role: 'member', roles: ['member', 'org-site-lead'],
    })
    listOrganizationRoles.mockResolvedValue({ data: [{ slug: 'org-site-lead', permissions: ['org:audit:view'] }] })

    const session = await resolvePinnedRequesterSession(requester)

    expect(session?.role).toBe('member')
    expect(session?.roles).toEqual(['member', 'org-site-lead'])
    expect([...(session?.permissions ?? [])].sort()).toEqual(['org:audit:view', 'org:projects:create'])
  })

  it('keeps what the catalog grants a role WorkOS has not been provisioned for yet', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({
      organizationMembershipId: 'om_1', role: 'admin', roles: ['admin'],
    })
    listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'admin', permissions: ['org:settings:manage'] }] })

    const session = await resolvePinnedRequesterSession(requester)
    expect(session?.permissions).toContain('org:settings:manage')
    expect(session?.permissions).toContain(ORG_PERMISSIONS.projectsAdminister)
  })

  it('falls back to the catalog for a catalog role when WorkOS cannot say what it holds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    listEnvironmentRoles.mockRejectedValue(new Error('workos 503'))

    const session = await resolvePinnedRequesterSession(requester)
    expect(session?.permissions).toEqual(['org:projects:create'])
  })

  it('throws for a custom role WorkOS cannot answer for, so the job retries instead of acting with nothing', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({
      organizationMembershipId: 'om_1', role: 'org-geschaeftsfuehrung', roles: ['org-geschaeftsfuehrung'],
    })
    listOrganizationRoles.mockRejectedValue(new Error('workos 429'))

    await expect(resolvePinnedRequesterSession(requester)).rejects.toThrow('workos 429')
  })
})

describe('resolvePinnedRequesterSessionStrict', () => {
  it('builds the same session for a member', async () => {
    expect(await resolvePinnedRequesterSessionStrict(requester)).toMatchObject({ userId: 'user_owner', role: 'member' })
    expect(lookupSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner')
  })

  it('answers null only when WorkOS said the person is not a member', async () => {
    vi.mocked(lookupSubjectMembership).mockResolvedValueOnce(null)
    expect(await resolvePinnedRequesterSessionStrict(requester)).toBeNull()
  })

  it('throws when WorkOS could not be asked, so a caller does not act on "they left"', async () => {
    vi.mocked(lookupSubjectMembership).mockRejectedValueOnce(new Error('workos 503'))
    await expect(resolvePinnedRequesterSessionStrict(requester)).rejects.toThrow('workos 503')
  })
})
