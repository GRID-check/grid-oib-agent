/**
 * A member-scope budget policy must name a member of the organization.
 *
 * The failure this pins is the quiet kind: an admin types (or pastes, or
 * autocompletes wrongly) a user id that is not in this organization, the write
 * succeeds, the settings page lists a limit, and the limit does nothing — spend
 * is joined on the member's id and no row ever matches. Nothing is thrown,
 * nothing is logged, and the organization believes it has a cap it does not
 * have. That is worse than the write being refused, which is why this is a
 * validation error and not a silent normalization.
 *
 * The clear path is deliberately NOT roster-checked, and that asymmetry has its
 * own test below: the one member-scope row an admin most wants to remove is the
 * one whose subject has since left.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { BudgetPolicy } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))

const canManageBudgets = vi.fn(() => true)
vi.mock('@/lib/authz/organizations', () => ({ canManageBudgets: () => canManageBudgets() }))

const resolveSubjectMembership = vi.fn()
vi.mock('@/lib/authz/project-membership', () => ({
  resolveSubjectMembership: (organizationId: string, userId: string) =>
    resolveSubjectMembership(organizationId, userId),
}))

const requireProjectAccess = vi.fn(async () => {})
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: () => requireProjectAccess() }))

const findProjectTenancy = vi.fn()
vi.mock('@/lib/projects/repository', () => ({ findProjectTenancy: (id: string) => findProjectTenancy(id) }))

const recordAuditEvent = vi.fn(async () => {})
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: () => recordAuditEvent() }))

vi.mock('@/lib/llm-credentials/service', () => ({ isOrgOnOwnKey: async () => false }))

vi.mock('@/lib/pricing/service', () => ({
  getEffectivePricing: async () => ({ defaultOrgDailyCredits: 1000, defaultOrgMonthlyCredits: 10000 }),
  getEffectivePricingOrBootFloor: async () => ({ defaultOrgDailyCredits: 1000, defaultOrgMonthlyCredits: 10000 }),
  creditsToCostUsd: () => 0,
  priceUsage: () => ({}),
}))

const invalidateCached = vi.fn(async (_key: string) => {})
vi.mock('@/lib/cache', () => ({
  getCached: async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
  invalidateCached: (key: string) => invalidateCached(key),
  invalidateCachedPrefix: async () => {},
}))

const insertPolicySuperseding = vi.fn()
const supersedeActivePolicy = vi.fn(async () => true)
const findActivePolicy = vi.fn<(...args: unknown[]) => Promise<BudgetPolicy | null>>()
const sumRollupTotals = vi.fn()

vi.mock('./repository', () => ({
  findActivePolicy: (...args: unknown[]) => findActivePolicy(...args),
  insertPolicySuperseding: (values: unknown) => insertPolicySuperseding(values),
  supersedeActivePolicy: (...args: unknown[]) => supersedeActivePolicy(...(args as [])),
  listActivePolicies: async () => [],
  listPolicyHistory: async () => [],
  utcDayStart: () => new Date(0),
  utcMonthStart: () => new Date(0),
  sumSpendWindows: () => ({}),
  EMPTY_SPEND_WINDOW: {},
  sumRollupTotals: (...args: unknown[]) => sumRollupTotals(...args),
}))

const session: AuthorizedSession = {
  userId: 'user_admin',
  organizationId: 'org_1',
  email: 'admin@example.com',
} as AuthorizedSession

const request = new Request('https://piloti.test/api/budgets/policies', { method: 'POST' })

const storedPolicy = { id: 'pol_1', currency: 'credit' } as unknown as BudgetPolicy

beforeEach(() => {
  canManageBudgets.mockReturnValue(true)
  insertPolicySuperseding.mockResolvedValue(storedPolicy)
  supersedeActivePolicy.mockResolvedValue(true)
  findActivePolicy.mockResolvedValue(null)
  resolveSubjectMembership.mockReset()
  sumRollupTotals.mockResolvedValue({ day: { credits: 25, tokens: 1000 }, month: { credits: 10000, tokens: 20000 } })
})

describe('setBudgetPolicy, expected unit', () => {
  it('refuses a stale unit before superseding or inserting a policy', async () => {
    const { setBudgetPolicy } = await import('./service')
    const { ConflictError } = await import('@/lib/api/errors')
    await expect(setBudgetPolicy({
      organizationId: 'org_1',
      scope: 'organization',
      subjectId: null,
      dailyLimit: 1000,
      monthlyLimit: 20000,
      actorUserId: 'user_admin',
      expectedUnit: 'token',
    })).rejects.toBeInstanceOf(ConflictError)
    expect(insertPolicySuperseding).not.toHaveBeenCalled()
  })

  it('uses the existing append-only policy writer for a matching credit allowance', async () => {
    const { setBudgetPolicy } = await import('./service')
    await setBudgetPolicy({
      organizationId: 'org_1',
      scope: 'organization',
      subjectId: null,
      dailyLimit: null,
      monthlyLimit: 20000,
      actorUserId: 'user_admin',
      expectedUnit: 'credit',
    })
    expect(insertPolicySuperseding).toHaveBeenCalledWith({
      organizationId: 'org_1', scope: 'organization', subjectId: null, unit: 'credit',
      dailyLimit: null, monthlyLimit: '20000.0000', createdBy: 'user_admin', note: null,
    })
    expect(invalidateCached).toHaveBeenCalledWith('budgetlimits:org_1:credit:organization:')
    expect(invalidateCached).toHaveBeenCalledWith('budgetlimits:org_1:token:organization:')
  })

  it.each([
    { allowance: 0, remaining: 0, blocked: true },
    { allowance: 10000, remaining: 0, blocked: true },
    { allowance: 20000, remaining: 10000, blocked: false },
  ])('enforces the saved monthly allowance $allowance against current credit usage', async ({ allowance, remaining, blocked }) => {
    const { getBudgetStatus, setBudgetPolicy } = await import('./service')
    insertPolicySuperseding.mockImplementationOnce(async (values: { monthlyLimit: string }) => {
      const policy = { ...storedPolicy, dailyLimit: null, monthlyLimit: values.monthlyLimit }
      findActivePolicy.mockResolvedValue(policy)
      return policy
    })
    await setBudgetPolicy({
      organizationId: 'org_1', scope: 'organization', subjectId: null,
      dailyLimit: null, monthlyLimit: allowance, actorUserId: 'user_admin', expectedUnit: 'credit',
    })
    expect(await getBudgetStatus('org_1', null, null)).toMatchObject({
      unit: 'credit', remainingOrg: remaining, blocked,
      blockedScope: blocked ? 'organization' : null,
    })
  })
})

describe('saveBudgetPolicy, member scope', () => {
  it('refuses a subject who is not a member of the organization', async () => {
    const { saveBudgetPolicy } = await import('./service')
    const { BadRequestError } = await import('@/lib/api/errors')
    resolveSubjectMembership.mockResolvedValue(null)

    await expect(
      saveBudgetPolicy(
        session,
        { scope: 'member', subjectId: 'user_from_another_org', dailyLimit: 10, monthlyLimit: 100 },
        request,
      ),
    ).rejects.toBeInstanceOf(BadRequestError)

    // The roster check runs BEFORE the write, so nothing is stored and no audit
    // event claims something happened.
    expect(insertPolicySuperseding).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_from_another_org')
  })

  it('stores a policy for a real member', async () => {
    const { saveBudgetPolicy } = await import('./service')
    resolveSubjectMembership.mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member' })

    await expect(
      saveBudgetPolicy(
        session,
        { scope: 'member', subjectId: 'user_2', dailyLimit: 10, monthlyLimit: 100 },
        request,
      ),
    ).resolves.toBe(storedPolicy)

    expect(insertPolicySuperseding).toHaveBeenCalledTimes(1)
  })

  it('asks the roster of THIS organization, never of the subject', async () => {
    // The membership resolver takes (organizationId, userId) in that order, and
    // swapping them is the mistake that would make every check pass in dev,
    // where an admin's own id is also an org id in nobody's roster.
    const { saveBudgetPolicy } = await import('./service')
    resolveSubjectMembership.mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member' })

    await saveBudgetPolicy(
      session,
      { scope: 'member', subjectId: 'user_2', dailyLimit: 10, monthlyLimit: 100 },
      request,
    )

    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_2')
  })

  it('refuses a member policy with no subject at all', async () => {
    const { saveBudgetPolicy } = await import('./service')
    const { BadRequestError } = await import('@/lib/api/errors')

    await expect(
      saveBudgetPolicy(session, { scope: 'member', subjectId: null, dailyLimit: 10, monthlyLimit: 100 }, request),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(resolveSubjectMembership).not.toHaveBeenCalled()
  })

  it('is authorization first: a non-admin is forbidden before the roster is read', async () => {
    const { saveBudgetPolicy } = await import('./service')
    const { ForbiddenError } = await import('@/lib/api/errors')
    canManageBudgets.mockReturnValue(false)

    await expect(
      saveBudgetPolicy(session, { scope: 'member', subjectId: 'user_2', dailyLimit: 10, monthlyLimit: 100 }, request),
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(resolveSubjectMembership).not.toHaveBeenCalled()
  })
})

describe('removeBudgetPolicy, member scope', () => {
  it('removes a departed member’s stale policy without consulting the roster', async () => {
    // The cure for the row this ticket is about. A roster check here would make
    // it permanent: the subject is exactly the person who is no longer a member.
    const { removeBudgetPolicy } = await import('./service')
    resolveSubjectMembership.mockResolvedValue(null)

    await expect(
      removeBudgetPolicy(session, { scope: 'member', subjectId: 'user_who_left' }, request),
    ).resolves.toBe(true)

    expect(resolveSubjectMembership).not.toHaveBeenCalled()
    expect(supersedeActivePolicy).toHaveBeenCalledTimes(1)
  })
})

describe('the other scopes are unchanged', () => {
  it('organization scope needs no subject and no roster lookup', async () => {
    const { saveBudgetPolicy } = await import('./service')

    await expect(
      saveBudgetPolicy(session, { scope: 'organization', dailyLimit: 500, monthlyLimit: 5000 }, request),
    ).resolves.toBe(storedPolicy)
    expect(resolveSubjectMembership).not.toHaveBeenCalled()
  })

  it('project scope still validates the project against the org', async () => {
    const { saveBudgetPolicy } = await import('./service')
    const { BadRequestError } = await import('@/lib/api/errors')
    findProjectTenancy.mockResolvedValue({ organizationId: 'org_other' })

    await expect(
      saveBudgetPolicy(session, { scope: 'project', subjectId: 'proj_1', dailyLimit: 10, monthlyLimit: 100 }, request),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(resolveSubjectMembership).not.toHaveBeenCalled()
  })
})
